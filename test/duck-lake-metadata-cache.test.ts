import { describe, it, beforeAll, afterAll, afterEach, expect, vi } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { DuckDBProvider, DuckLakeProvider } from '../src/index.js';
import type { DuckLakeLocals, DuckLakeTenant, ProviderRequest } from '../src/index.js';

type LakeRequest = ProviderRequest<Record<string, string>, DuckLakeLocals>;

function fakeReq(db: DuckDBConnection, tenant: DuckLakeTenant): LakeRequest {
    return { params: {}, query: {}, baseUrl: '', res: { locals: { db, tenant } } } as unknown as LakeRequest;
}

const TENANT: DuckLakeTenant = { company: 'org', user: 'usr', project: 'prj' };
const TABLE = '"org_usr_prj_roads"';

/** Type-only access to the protected lookups being counted. */
type Lookups = Record<'geometryColumn' | 'temporalColumnKinds' | 'declaredGeometryCrs', () => Promise<unknown>>;

describe('DuckLakeProvider metadataCacheTtlMs', () => {
    let instance: DuckDBInstance;
    let db: DuckDBConnection;

    beforeAll(async () => {
        instance = await DuckDBInstance.create(':memory:');
        db = await instance.connect();
        await db.run('LOAD spatial;');
        await db.run(`CREATE TABLE ${TABLE} (id VARCHAR, built DATE, geometry GEOMETRY);`);
        await db.run(`INSERT INTO ${TABLE} VALUES ('r1', DATE '2026-01-02', ST_Point(511224.5191, 5488393.3794));`);
    });

    afterAll(() => {
        db.closeSync();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    function countLookups() {
        const proto = DuckDBProvider.prototype as unknown as Lookups;
        return {
            geometryColumn: vi.spyOn(proto, 'geometryColumn'),
            temporalColumnKinds: vi.spyOn(proto, 'temporalColumnKinds'),
            declaredGeometryCrs: vi.spyOn(proto, 'declaredGeometryCrs'),
        };
    }

    it('looks each table\'s metadata up once across requests', async () => {
        const provider = new DuckLakeProvider({ name: 'lake', metadataCacheTtlMs: 60_000, defaultStorageCrs: 'EPSG:25832' });
        const spies = countLookups();

        for (let i = 0; i < 3; i++) {
            const fc = await provider.getFeatures(fakeReq(db, TENANT), 'roads', { limit: 10 });
            expect(fc.features).toHaveLength(1);
        }

        // geometryColumn is asked twice per request (plain and `broad`), each memoised once.
        expect(spies.geometryColumn).toHaveBeenCalledTimes(2);
        expect(spies.temporalColumnKinds).toHaveBeenCalledTimes(1);
        expect(spies.declaredGeometryCrs).toHaveBeenCalledTimes(1);
    });

    it('keeps the old per-request lookups when the option is unset', async () => {
        const provider = new DuckLakeProvider({ name: 'lake', defaultStorageCrs: 'EPSG:25832' });
        const spies = countLookups();

        await provider.getFeatures(fakeReq(db, TENANT), 'roads', { limit: 10 });
        await provider.getFeatures(fakeReq(db, TENANT), 'roads', { limit: 10 });

        expect(spies.temporalColumnKinds).toHaveBeenCalledTimes(2);
    });

    // Without a TTL the comment-CRS cache lives until restart, so a CRS
    // recorded on an existing table (a backfill) was ignored until then.
    it('picks up a CRS comment added after the table was first read, once the TTL passes', async () => {
        await db.run(`CREATE TABLE "org_usr_prj_late" (id VARCHAR, geometry GEOMETRY);`);
        await db.run(`INSERT INTO "org_usr_prj_late" VALUES ('l1', ST_Point(550000, 3255000));`);
        const provider = new DuckLakeProvider({
            name: 'lake',
            crsMode: 'native',
            defaultStorageCrs: 'EPSG:25832',
            metadataCacheTtlMs: 50,
        });

        const before = await provider.getCollection(fakeReq(db, TENANT), 'late');
        expect(before?.storageCrs).toBe('http://www.opengis.net/def/crs/EPSG/0/25832');

        await db.run(`COMMENT ON COLUMN "org_usr_prj_late".geometry IS 'EPSG:32614'`);
        await new Promise((resolve) => setTimeout(resolve, 80));

        const after = await provider.getCollection(fakeReq(db, TENANT), 'late');
        expect(after?.storageCrs).toBe('http://www.opengis.net/def/crs/EPSG/0/32614');
        const feature = await provider.getFeature(fakeReq(db, TENANT), 'late', 'l1');
        const [lon] = (feature?.geometry as { coordinates: number[] }).coordinates;
        expect(lon).toBeCloseTo(-98.48, 1); // San Antonio, not the Sahara.
    });
});
