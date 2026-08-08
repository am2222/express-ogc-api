import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import {
    DuckLakeProvider,
    FeatureValidationError,
    OGCAPIConformanceClass,
} from '../src/index.js';
import type { DuckLakeLocals, DuckLakeTenant, ProviderRequest } from '../src/index.js';

type LakeRequest = ProviderRequest<Record<string, string>, DuckLakeLocals>;

/**
 * These run against plain DuckDB, not a real DuckLake catalog — deliberately,
 * so the suite needs no Postgres and no S3 credentials.
 *
 * That still exercises the logic under test, because everything
 * `DuckLakeProvider` overrides is written to avoid the DuckLake-specific gaps
 * rather than to depend on them: `createFeature` never emits `RETURNING` (which
 * DuckLake rejects) and detects id collisions with an explicit read instead of
 * a `UNIQUE` violation (which DuckLake cannot raise). Both behaviours are
 * observable on plain DuckDB too. What is NOT covered here is the ATTACH path
 * itself (`attachDuckLake`), which needs the live catalog.
 */
function fakeReq(db: DuckDBConnection, tenant?: Partial<DuckLakeTenant>): LakeRequest {
    const res = { locals: { db, tenant } };
    return { params: {}, query: {}, baseUrl: '', res } as unknown as LakeRequest;
}

const TENANT: DuckLakeTenant = {
    company: 'GA0gA0DcMF',
    user: 't5OtsEjChL',
    project: '7CHCwAJQiO',
};

describe('DuckLakeProvider', () => {
    let instance: DuckDBInstance;
    let db: DuckDBConnection;
    let provider: DuckLakeProvider;
    let tmpDir: string;

    beforeAll(async () => {
        instance = await DuckDBInstance.create(':memory:');
        db = await instance.connect();
        await db.run('LOAD spatial;');
        tmpDir = mkdtempSync(join(tmpdir(), 'ducklake-test-'));

        // This tenant's layers.
        await db.run(`
            CREATE TABLE "GA0gA0DcMF_t5OtsEjChL_7CHCwAJQiO_chambers" (
                id VARCHAR DEFAULT uuid(),
                ch_type VARCHAR,
                geometry GEOMETRY
            );
        `);
        await db.run(`
            INSERT INTO "GA0gA0DcMF_t5OtsEjChL_7CHCwAJQiO_chambers" (id, ch_type, geometry)
            VALUES ('c1', 'manhole', ST_Point(511224.5191, 5488393.3794));
        `);

        // A layer whose id column has NO default — the server cannot invent an id.
        await db.run(`
            CREATE TABLE "GA0gA0DcMF_t5OtsEjChL_7CHCwAJQiO_road_network" (
                id VARCHAR,
                name VARCHAR,
                geometry GEOMETRY
            );
            INSERT INTO "GA0gA0DcMF_t5OtsEjChL_7CHCwAJQiO_road_network"
            VALUES ('r1', 'Main St', ST_Point(1, 2));
        `);

        // A layer name containing underscores of its own, so prefix-stripping is
        // shown not to depend on splitting the table name into components.
        await db.run(`
            CREATE TABLE "GA0gA0DcMF_t5OtsEjChL_7CHCwAJQiO_backbone_feeder_cable" (
                id VARCHAR DEFAULT uuid(), geometry GEOMETRY
            );
        `);

        // Another tenant's layer, and a company-level table with no
        // user/project segment. Neither belongs to TENANT.
        await db.run(`
            CREATE TABLE "IuDYAyFJU7_wrF2wZnMco_fsTVCza4BX_chambers" (id VARCHAR, geometry GEOMETRY);
            CREATE TABLE "GA0gA0DcMF_billed_points" (id VARCHAR, geometry GEOMETRY);
        `);

        // A layer that DECLARES a projected storage CRS, so reprojection is on
        // for it and off for every other table here. Kept as its own table on
        // purpose: declaring the CRS changes what coordinates mean on both the
        // read and the write path, so it must not leak into the tests above
        // that deal in raw stored values.
        await db.run(`
            CREATE TABLE "GA0gA0DcMF_t5OtsEjChL_7CHCwAJQiO_projected" (
                id VARCHAR DEFAULT uuid(),
                label VARCHAR,
                geometry GEOMETRY
            );
        `);
        // The only CRS mechanism DuckLake persists — see the provider docstring.
        await db.run(
            `COMMENT ON COLUMN "GA0gA0DcMF_t5OtsEjChL_7CHCwAJQiO_projected".geometry IS 'EPSG:25832'`
        );
        // Stored in UTM 32N. In CRS84 this is lon 9.15517, lat 49.54804.
        await db.run(`
            INSERT INTO "GA0gA0DcMF_t5OtsEjChL_7CHCwAJQiO_projected" (id, label, geometry)
            VALUES ('utm-1', 'stored in UTM', ST_Point(511224.5191, 5488393.3794));
        `);

        provider = new DuckLakeProvider({ name: 'lake' });
    });

    afterAll(() => {
        db?.disconnectSync();
        if (tmpDir) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    describe('tenant scoping', () => {
        it('exposes only this tenant\'s layers, with the prefix stripped', async () => {
            const ids = (await provider.getCollections(fakeReq(db, TENANT))).map((c) => c.id);

            expect(ids.sort()).toEqual([
                'backbone_feeder_cable',
                'chambers',
                'projected',
                'road_network',
            ]);
        });

        it('hides another tenant\'s layer and the company-level table', async () => {
            const ids = (await provider.getCollections(fakeReq(db, TENANT))).map((c) => c.id);

            // Both exist in the catalog and both are invisible here: the other
            // tenant's `chambers` would otherwise collide with this tenant's,
            // and `GA0gA0DcMF_billed_points` shares this tenant's company but
            // has no user/project segment to match.
            expect(ids).not.toContain('IuDYAyFJU7_wrF2wZnMco_fsTVCza4BX_chambers');
            expect(ids).not.toContain('billed_points');
            expect(await provider.getCollection(fakeReq(db, TENANT), 'billed_points')).toBeNull();
        });

        it('resolves reads against this tenant\'s table', async () => {
            const feature = await provider.getFeature(fakeReq(db, TENANT), 'chambers', 'c1');

            expect(feature?.properties.ch_type).toBe('manhole');
        });

        it('cannot be steered into another tenant\'s table by a crafted collection id', async () => {
            // The only name that reaches SQL is `<prefix><collectionId>`, so this
            // resolves to a table that does not exist rather than to the other
            // tenant's `chambers`.
            const other = await provider.getCollection(
                fakeReq(db, TENANT),
                'IuDYAyFJU7_wrF2wZnMco_fsTVCza4BX_chambers'
            );

            expect(other).toBeNull();
        });

        it('rejects a tenant component containing an underscore', async () => {
            // `_` separates the triple from the collection id, so allowing it in
            // a component would let one tenant address another's prefix.
            await expect(
                provider.getCollections(fakeReq(db, { ...TENANT, project: '7CHCwAJQiO_x' }))
            ).rejects.toThrow(/project/);
        });

        it('rejects an empty or missing tenant rather than falling back to unprefixed tables', async () => {
            await expect(provider.getCollections(fakeReq(db, undefined))).rejects.toThrow(
                /res\.locals\.tenant/
            );
            await expect(
                provider.getCollections(fakeReq(db, { ...TENANT, company: '' }))
            ).rejects.toThrow(/company/);
        });
    });

    describe('conformance', () => {
        it('advertises Part 4 (CRUD) and Part 2 (CRS) on top of the base classes', () => {
            const classes = provider.conformanceClasses();

            // Without Part 4 a fully write-capable server reads as read-only to
            // clients that decide editability from the conformance list.
            expect(classes).toContain(OGCAPIConformanceClass.FEATURES_CREATE_REPLACE_DELETE);
            expect(classes).toContain(OGCAPIConformanceClass.FEATURES_UPDATE);
            expect(classes).toContain(OGCAPIConformanceClass.FEATURES_FEATURES);
            expect(classes).toContain(OGCAPIConformanceClass.FEATURES_CRS);
            expect(classes).toContain(OGCAPIConformanceClass.FEATURES_CORE);
        });
    });

    describe('storage CRS', () => {
        it('reads the CRS from the geometry column comment', async () => {
            const collection = await provider.getCollection(fakeReq(db, TENANT), 'projected');

            expect(collection?.storageCrs).toBe('http://www.opengis.net/def/crs/EPSG/0/25832');
            expect(collection?.crs).toContain('http://www.opengis.net/def/crs/EPSG/0/25832');
            // CRS84 stays listed: it is what a client assumes by default.
            expect(collection?.crs).toContain('http://www.opengis.net/def/crs/OGC/1.3/CRS84');
        });

        it('prefers the geometry column\'s declared type over a comment', async () => {
            // The authoritative source: spatial 2.x carries the CRS in the column
            // TYPE (`GEOMETRY('EPSG:25832')`), readable from `duckdb_columns()`
            // without reading a single row — the same value `ST_CRS()` reports,
            // but without the data scan. DuckLake happens to drop the type
            // parameter today, which is what the comment fallback is for; where
            // the type survives it must win over a stale comment.
            await db.run(`
                CREATE TABLE "GA0gA0DcMF_t5OtsEjChL_7CHCwAJQiO_typed" (
                    id VARCHAR DEFAULT uuid(),
                    geometry GEOMETRY('EPSG:25832')
                );
            `);
            await db.run(
                `COMMENT ON COLUMN "GA0gA0DcMF_t5OtsEjChL_7CHCwAJQiO_typed".geometry IS 'EPSG:3857'`
            );
            await db.run(`
                INSERT INTO "GA0gA0DcMF_t5OtsEjChL_7CHCwAJQiO_typed" (id, geometry)
                VALUES ('t1', ST_Point(511224.5191, 5488393.3794));
            `);

            const collection = await provider.getCollection(fakeReq(db, TENANT), 'typed');
            expect(collection?.storageCrs).toBe('http://www.opengis.net/def/crs/EPSG/0/25832');

            // And it drives the transform, not just the metadata.
            const feature = await provider.getFeature(fakeReq(db, TENANT), 'typed', 't1');
            const coords = (feature?.geometry as { coordinates: number[] }).coordinates;
            expect(coords[0]).toBeCloseTo(9.15517, 4);
            expect(coords[1]).toBeCloseTo(49.54804, 4);
        });

        it('recovers the CRS from the underlying Parquet files', async () => {
            // The real source of truth for a DuckLake table. DuckLake's catalog
            // stores the column type as a bare `geometry`, but the Parquet files
            // it writes carry the CRS in the native GEOMETRY logical type as
            // PROJJSON — so `ST_CRS` reads NULL through the lake table and the
            // correct value through `read_parquet` on the same data.
            //
            // Written as a real Parquet file here (rather than mocked) so the
            // PROJJSON parsing runs against DuckDB's actual output. File
            // discovery via `ducklake_list_files` needs a live catalog, so it is
            // stubbed; it is exercised end-to-end against the real lake instead.
            const path = `${tmpDir}/parquet_crs.parquet`;
            await db.run(`
                COPY (SELECT ST_SetCRS(ST_Point(511224.5191, 5488393.3794), 'EPSG:32632') AS geometry)
                TO '${path}' (FORMAT parquet)
            `);

            class StubbedFiles extends DuckLakeProvider {
                protected override async dataFilePaths(): Promise<string[]> {
                    return [path];
                }
            }
            const stubbed = new StubbedFiles({ name: 'lake' });

            await db.run(`
                CREATE TABLE "GA0gA0DcMF_t5OtsEjChL_7CHCwAJQiO_from_parquet" (
                    id VARCHAR DEFAULT uuid(), geometry GEOMETRY
                );
            `);
            await db.run(`
                INSERT INTO "GA0gA0DcMF_t5OtsEjChL_7CHCwAJQiO_from_parquet" (id, geometry)
                VALUES ('p1', ST_Point(511224.5191, 5488393.3794));
            `);

            const collection = await stubbed.getCollection(fakeReq(db, TENANT), 'from_parquet');
            expect(collection?.storageCrs).toBe('http://www.opengis.net/def/crs/EPSG/0/32632');

            // And it drives the transform, not just the reported metadata.
            const feature = await stubbed.getFeature(fakeReq(db, TENANT), 'from_parquet', 'p1');
            const coords = (feature?.geometry as { coordinates: number[] }).coordinates;
            expect(coords[0]).toBeCloseTo(9.15517, 4);
            expect(coords[1]).toBeCloseTo(49.54804, 4);
        });

        it('omits storageCrs when nothing declares one', async () => {
            const collection = await provider.getCollection(fakeReq(db, TENANT), 'road_network');

            expect(collection?.storageCrs).toBeUndefined();
        });

        it('lets explicit config win over the column comment', async () => {
            const configured = new DuckLakeProvider({
                name: 'lake',
                crsByCollection: { projected: 'EPSG:4326' },
            });

            const collection = await configured.getCollection(fakeReq(db, TENANT), 'projected');

            expect(collection?.storageCrs).toBe('http://www.opengis.net/def/crs/EPSG/0/4326');
        });

        it('applies defaultStorageCrs only where nothing else declares one', async () => {
            const configured = new DuckLakeProvider({
                name: 'lake',
                defaultStorageCrs: 'EPSG:3857',
            });

            // `projected` carries a comment, so the comment wins over the default.
            const projected = await configured.getCollection(fakeReq(db, TENANT), 'projected');
            expect(projected?.storageCrs).toBe('http://www.opengis.net/def/crs/EPSG/0/25832');

            // road_network declares nothing, so it falls back to the default.
            const roads = await configured.getCollection(fakeReq(db, TENANT), 'road_network');
            expect(roads?.storageCrs).toBe('http://www.opengis.net/def/crs/EPSG/0/3857');
        });
    });

    describe('ST_Transform on read and write', () => {
        // Storage is EPSG:25832; the API speaks CRS84. Stored point
        // (511224.5191, 5488393.3794) is lon 9.15517, lat 49.54804.
        const LON = 9.15517054988813;
        const LAT = 49.54804108527769;

        it('serves stored projected coordinates as CRS84 lon/lat', async () => {
            const feature = await provider.getFeature(fakeReq(db, TENANT), 'projected', 'utm-1');
            const coords = (feature?.geometry as { coordinates: number[] }).coordinates;

            // Longitude first. Without always_xy this pair arrives reversed,
            // because EPSG:4326 declares latitude first.
            expect(coords[0]).toBeCloseTo(LON, 5);
            expect(coords[1]).toBeCloseTo(LAT, 5);
        });

        it('reports the collection extent in CRS84, matching extent.spatial.crs', async () => {
            const collection = await provider.getCollection(fakeReq(db, TENANT), 'projected');
            const bbox = collection?.extent?.spatial?.bbox?.[0] ?? [];

            expect(collection?.extent?.spatial?.crs).toBe(
                'http://www.opengis.net/def/crs/OGC/1.3/CRS84'
            );
            expect(bbox[0]).toBeCloseTo(LON, 4);
            expect(bbox[1]).toBeCloseTo(LAT, 4);
        });

        it('round-trips a CRS84 POST: projected into storage, read back as CRS84', async () => {
            const created = await provider.createFeature(fakeReq(db, TENANT), 'projected', {
                type: 'Feature',
                properties: { id: 'crs84-post', label: 'posted in lon/lat' },
                geometry: { type: 'Point', coordinates: [LON, LAT] },
            });

            const coords = (created?.geometry as { coordinates: number[] }).coordinates;
            expect(coords[0]).toBeCloseTo(LON, 5);
            expect(coords[1]).toBeCloseTo(LAT, 5);

            // And the value actually on disk is the projected one, not the
            // lon/lat that came in — the read above is a transform, not a
            // pass-through of what was written.
            const stored = await db.runAndReadAll(
                `SELECT ST_X(geometry) x, ST_Y(geometry) y
                 FROM "GA0gA0DcMF_t5OtsEjChL_7CHCwAJQiO_projected" WHERE id = 'crs84-post'`
            );
            const row = stored.getRowObjectsJS()[0];
            expect(Number(row?.x)).toBeCloseTo(511224.5191, 2);
            expect(Number(row?.y)).toBeCloseTo(5488393.3794, 2);
        });

        it('round-trips a CRS84 PUT', async () => {
            const replaced = await provider.replaceFeature(
                fakeReq(db, TENANT),
                'projected',
                'utm-1',
                {
                    type: 'Feature',
                    properties: { label: 'replaced in lon/lat' },
                    geometry: { type: 'Point', coordinates: [LON, LAT] },
                }
            );

            const coords = (replaced?.geometry as { coordinates: number[] }).coordinates;
            expect(coords[0]).toBeCloseTo(LON, 5);
            expect(coords[1]).toBeCloseTo(LAT, 5);
        });

        it('matches a bbox given in CRS84 against projected storage', async () => {
            const inside = await provider.getFeatures(fakeReq(db, TENANT), 'projected', {
                bbox: [LON - 0.01, LAT - 0.01, LON + 0.01, LAT + 0.01],
            } as never);
            expect(inside.numberMatched).toBeGreaterThan(0);

            // A bbox nowhere near the data must not match — proving the filter is
            // really being compared in CRS84, not against raw UTM numbers that
            // would fall outside any lon/lat box and match nothing either way.
            const elsewhere = await provider.getFeatures(fakeReq(db, TENANT), 'projected', {
                bbox: [0, 0, 1, 1],
            } as never);
            expect(elsewhere.numberMatched).toBe(0);
        });

        it('matches a CQL2 spatial filter given in CRS84', async () => {
            const result = await provider.getFeatures(fakeReq(db, TENANT), 'projected', {
                filter: `S_INTERSECTS(geometry, BBOX(${LON - 0.01},${LAT - 0.01},${LON + 0.01},${LAT + 0.01}))`,
                filterLang: 'cql2-text',
            } as never);

            expect(result.numberMatched).toBeGreaterThan(0);
        });

        it('leaves a collection with no declared CRS untouched', async () => {
            // No comment, no config: nothing can be reprojected from an unknown
            // CRS, so the stored numbers pass straight through.
            const feature = await provider.getFeature(fakeReq(db, TENANT), 'road_network', 'r1');
            const coords = (feature?.geometry as { coordinates: number[] }).coordinates;

            expect(coords).toEqual([1, 2]);
        });
    });

    describe('createFeature without RETURNING', () => {
        it('honours a non-colliding client-supplied id', async () => {
            const created = await provider.createFeature(fakeReq(db, TENANT), 'chambers', {
                type: 'Feature',
                properties: { id: 'fresh-1', ch_type: 'joint' },
                geometry: { type: 'Point', coordinates: [511000, 5488000] },
            });

            expect(created?.id).toBe('fresh-1');
            expect(created?.properties.ch_type).toBe('joint');
            expect(created?.geometry).toEqual({ type: 'Point', coordinates: [511000, 5488000] });
        });

        it('assigns a fresh id when a client-supplied id collides on a self-assigning column', async () => {
            // 'c1' already exists. DuckLake has no UNIQUE to violate, so the
            // collision is caught by an explicit read; because the column has a
            // default the server may invent a replacement rather than 409.
            const created = await provider.createFeature(fakeReq(db, TENANT), 'chambers', {
                type: 'Feature',
                properties: { id: 'c1', ch_type: 'duplicate-attempt' },
                geometry: { type: 'Point', coordinates: [0, 0] },
            });

            expect(created).not.toBeNull();
            expect(created?.id).not.toBe('c1');
            expect(created?.properties.ch_type).toBe('duplicate-attempt');

            // The original row is untouched.
            const original = await provider.getFeature(fakeReq(db, TENANT), 'chambers', 'c1');
            expect(original?.properties.ch_type).toBe('manhole');
        });

        it('generates an id when the client supplies none and the column self-assigns', async () => {
            const created = await provider.createFeature(fakeReq(db, TENANT), 'chambers', {
                type: 'Feature',
                properties: { ch_type: 'generated' },
                geometry: { type: 'Point', coordinates: [1, 1] },
            });

            expect(created?.id).toBeTruthy();
            // Readable back by the id the server chose — the point of deciding it
            // before the INSERT, since DuckLake cannot RETURNING it afterwards.
            const reread = await provider.getFeature(
                fakeReq(db, TENANT),
                'chambers',
                String(created?.id)
            );
            expect(reread?.properties.ch_type).toBe('generated');
        });

        it('gives distinct ids to two consecutive id-less POSTs', async () => {
            const req = fakeReq(db, TENANT);
            const a = await provider.createFeature(req, 'chambers', {
                type: 'Feature',
                properties: { ch_type: 'a' },
                geometry: null,
            });
            const b = await provider.createFeature(req, 'chambers', {
                type: 'Feature',
                properties: { ch_type: 'b' },
                geometry: null,
            });

            expect(a?.id).not.toBe(b?.id);
        });

        it('409s on a collision when the id column has no default', async () => {
            await expect(
                provider.createFeature(fakeReq(db, TENANT), 'road_network', {
                    type: 'Feature',
                    properties: { id: 'r1', name: 'Colliding' },
                    geometry: null,
                })
            ).rejects.toMatchObject({ name: 'FeatureValidationError', status: 409 });
        });

        it('400s when no id is supplied and the column cannot self-assign', async () => {
            // DuckLake has no sequences and no identity columns, so there is
            // genuinely no id the server could assign here.
            await expect(
                provider.createFeature(fakeReq(db, TENANT), 'road_network', {
                    type: 'Feature',
                    properties: { name: 'No id' },
                    geometry: null,
                })
            ).rejects.toBeInstanceOf(FeatureValidationError);
        });
    });
});
