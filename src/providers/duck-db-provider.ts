import type { DuckDBConnection, DuckDBValue, JS } from '@duckdb/node-api';

// biome-ignore assist/source/organizeImports: <explanation>
import type {
    Collection,
    Feature,
    FeatureCollection,
    ProviderRequest,
    Queryable,
    QueryParams,
    UpdateFeatureParams,
} from '@/types';
import { OGCAPIConformanceItem, OGCAPIConformanceClass } from '@/types/ogc-confirmance';
import { BaseProvider, type ProviderDef } from '@/providers/base-provider';

export interface DuckDBLocals {
    db: DuckDBConnection;
    /** Tenant key. Tables for this tenant are named `<key>_<collection>`. Omit for a flat, single-tenant database. */
    key?: string;
}

export interface DuckDBProviderDef extends ProviderDef {}

type DuckDBRequest = ProviderRequest<Record<string, string>, DuckDBLocals>;

export class DuckDBProvider extends BaseProvider<Record<string, string>, DuckDBLocals> {
    public override readonly enableSchemas = true;
    public override readonly enableFiltering = true;
    public override readonly enableTransactions = true;

    /**
     * Per-request memo of the full collection list (`getCollections`), keyed by
     * `req.res`. A WeakMap means entries are garbage-collected along with the
     * response — nothing outlives the request that created it, and there is no
     * cross-request cache-invalidation problem to manage. `getCollection` never
     * consults this: it always does its own single-table lookup (see below), so
     * a single-item read never pays for a full-catalog scan.
     */
    private readonly discoveryMemo = new WeakMap<object, Promise<Collection[]>>();

    /**
     * The connection for this request. Application middleware is responsible for
     * opening it, loading any extensions it needs, and closing it — the provider
     * borrows it for the duration of the call and never retains it.
     *
     * `req.res` is typed non-optional, but that's a contract, not a guarantee —
     * guard it anyway so a request that violates it fails with this message
     * instead of a raw `TypeError: Cannot read properties of undefined`.
     */
    private conn(req: DuckDBRequest): DuckDBConnection {
        const db = req.res?.locals?.db;
        if (!db) {
            throw new Error(
                'DuckDBProvider: no connection found at res.locals.db — mount middleware that sets it before the OGC router'
            );
        }
        return db;
    }

    /** The tenant key for this request, if middleware set one. */
    private tenantKey(req: DuckDBRequest): string | undefined {
        return req.res?.locals?.key;
    }

    /**
     * Quote an identifier for interpolation. DuckDB identifiers are double-quoted
     * and an embedded quote is doubled. Reject a NUL byte outright.
     */
    private quote(identifier: string): string {
        if (identifier.includes('\0')) {
            throw new Error(`Invalid identifier: ${identifier}`);
        }
        return `"${identifier.replace(/"/g, '""')}"`;
    }

    /**
     * Map a collection id to its physical table name. Tenants are table-name
     * prefixes on one shared database/connection, not separate schemas or
     * databases: with a key, every table a tenant can see or touch is named
     * `<key>_<collectionId>`. This is the only place that builds a physical
     * table name — every quoted table reference and every `information_schema`
     * lookup goes through it (or through a name it already produced).
     *
     * This is also what keeps the prefix from being bypassable: the key always
     * comes from `res.locals`, set by trusted middleware, never from caller
     * input, and it is always *prepended*, never parsed back out of
     * `collectionId`. A tenant with key `db1` passing a crafted collectionId
     * like `../db2_parks` or `db2_parks` still only ever addresses
     * `db1_../db2_parks` or `db1_db2_parks` — tables that don't exist — never
     * `db2_parks` itself. There is no code path that strips or reinterprets the
     * prefix based on what the caller sent.
     */
    private physicalName(collectionId: string, key: string | undefined): string {
        return key ? `${key}_${collectionId}` : collectionId;
    }

    /**
     * Which of the conventional id columns ('id', 'fid') actually exist on the
     * table. DuckDB's binder rejects a WHERE clause that references a column
     * the table doesn't have, so a hardcoded `id = ? OR fid = ?` fails on any
     * table without a `fid` column — this discovers what is really there.
     * `tableName` is a physical (already-prefixed) name.
     */
    private async idColumns(db: DuckDBConnection, tableName: string): Promise<string[]> {
        const reader = await db.runAndReadAll(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = ? AND column_name IN ('id', 'fid')
            `, [tableName]);
        return reader.getRowObjectsJS().map((row) => String(row['column_name']));
    }

    /** Build `"id" = ? OR "fid" = ?` for whichever id columns are present. */
    private idClause(columns: string[]): string {
        if (columns.length === 0) {
            throw new Error(`Collection has no 'id' or 'fid' column to identify features by`);
        }
        return columns.map((col) => `${this.quote(col)} = ?`).join(' OR ');
    }

    /**
     * The geometry column of a table, if any. `broad` widens the match beyond
     * `GEOMETRY` to the specific spatial types too (used for extent discovery,
     * where the column may not literally be typed `GEOMETRY`). `tableName` is a
     * physical (already-prefixed) name.
     */
    private async geometryColumn(
        db: DuckDBConnection,
        tableName: string,
        broad = false
    ): Promise<string | undefined> {
        const typeCondition = broad
            ? `(data_type LIKE '%GEOMETRY%' OR data_type LIKE '%POINT%' OR data_type LIKE '%POLYGON%' OR data_type LIKE '%LINESTRING%')`
            : `data_type LIKE '%GEOMETRY%'`;

        const reader = await db.runAndReadAll(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = ? AND ${typeCondition}
            LIMIT 1
            `, [tableName]);

        const row = reader.getRowObjectsJS()[0];
        return row ? String(row['column_name']) : undefined;
    }

    /**
     * Normalize a 4- or 6-element bbox to its 2D [minx, miny, maxx, maxy] form.
     * A 6-element bbox is `[minx, miny, minz, maxx, maxy, maxz]`; the z bounds
     * aren't used by the 2D spatial filter below, so they're dropped.
     */
    private bboxXY(bbox: QueryParams['bbox']): [number, number, number, number] | undefined {
        if (!bbox) {
            return undefined;
        }
        if (bbox.length === 6) {
            const [minx, miny, , maxx, maxy] = bbox;
            return [minx, miny, maxx, maxy];
        }
        return bbox;
    }

    /**
     * Build a `Feature` from a raw row. Strips the internal `__geometry_json`
     * projection column and the raw geometry column itself out of `properties`
     * — without the latter, DuckDB's raw WKB `Uint8Array`/`Buffer` for the
     * geometry ends up serialized into every feature's properties alongside the
     * parsed GeoJSON geometry.
     */
    private rowToFeature(row: Record<string, JS>, geometryColumn: string | undefined): Feature {
        const { __geometry_json, ...rest } = row;
        const properties: Record<string, unknown> = rest;
        if (geometryColumn) {
            delete properties[geometryColumn];
        }

        let geometry: unknown = null;
        if (__geometry_json) {
            try {
                geometry = JSON.parse(String(__geometry_json));
            } catch (err) {
                console.warn('Failed to parse geometry:', err);
            }
        }

        return {
            type: 'Feature',
            id: (properties.id ?? properties.fid) as string | number,
            geometry,
            properties,
        };
    }

    conformanceClasses(): OGCAPIConformanceItem[] {
        return [
            OGCAPIConformanceClass.COMMON_CORE,
            OGCAPIConformanceClass.COMMON_LANDING_PAGE,
            OGCAPIConformanceClass.COMMON_JSON,
            OGCAPIConformanceClass.FEATURES_CORE,
            OGCAPIConformanceClass.FEATURES_GEOJSON,
        ];
    }

    async getCollections(req: DuckDBRequest): Promise<Collection[]> {
        const cacheKey: object | undefined = req.res;
        if (cacheKey) {
            const cached = this.discoveryMemo.get(cacheKey);
            if (cached) {
                return cached;
            }
        }

        const promise = this.discoverCollections(req);
        if (cacheKey) {
            this.discoveryMemo.set(cacheKey, promise);
        }
        return promise;
    }

    private async discoverCollections(req: DuckDBRequest): Promise<Collection[]> {
        const db = this.conn(req);
        const key = this.tenantKey(req);

        const reader = key
            ? await db.runAndReadAll(`
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = current_schema() AND starts_with(table_name, ?)
                `, [`${key}_`])
            : await db.runAndReadAll(`
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = current_schema()
                  AND table_schema NOT IN ('information_schema', 'pg_catalog')
                `);

        const collections: Collection[] = [];
        for (const row of reader.getRowObjectsJS()) {
            const tableName = String(row['table_name']);
            const collectionId = key ? tableName.slice(key.length + 1) : tableName;
            collections.push({
                id: collectionId,
                title: collectionId,
                description: `Collection from table ${collectionId}`,
                extent: await this.getTableExtent(db, tableName),
                itemType: 'feature',
                crs: [this.defaultCrs],
            });
        }
        return collections;
    }

    async getCollection(req: DuckDBRequest, collectionId: string): Promise<Collection | null> {
        const db = this.conn(req);
        const key = this.tenantKey(req);
        const tableName = this.physicalName(collectionId, key);

        // Targeted lookup — never builds the whole collection list. `getCollection`
        // is called before every item read in items-curd.ts, so this must stay a
        // single-table check, not a full-catalog scan with an ST_Extent per table.
        const reader = await db.runAndReadAll(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = ?
            `, [tableName]);

        if (reader.getRowObjectsJS().length === 0) {
            return null;
        }

        return {
            id: collectionId,
            title: collectionId,
            description: `Collection from table ${collectionId}`,
            extent: await this.getTableExtent(db, tableName),
            itemType: 'feature',
            crs: [this.defaultCrs],
        };
    }

    /** `tableName` is a physical (already-prefixed) name. */
    private async getTableExtent(db: DuckDBConnection, tableName: string): Promise<any> {
        try {
            const geometryColumn = await this.geometryColumn(db, tableName, true);

            if (geometryColumn) {
                const extent = await db.runAndReadAll(`
          SELECT
            ST_XMin(ST_Extent(${this.quote(geometryColumn)})) as minx,
            ST_YMin(ST_Extent(${this.quote(geometryColumn)})) as miny,
            ST_XMax(ST_Extent(${this.quote(geometryColumn)})) as maxx,
            ST_YMax(ST_Extent(${this.quote(geometryColumn)})) as maxy
          FROM ${this.quote(tableName)}
        `);
                const extentRow = extent.getRowObjectsJS()[0];

                if (extentRow) {
                    return {
                        spatial: {
                            bbox: [[
                                Number(extentRow.minx),
                                Number(extentRow.miny),
                                Number(extentRow.maxx),
                                Number(extentRow.maxy),
                            ]],
                            crs: this.defaultCrs,
                        },
                    };
                }
            }
        } catch (err) {
            console.warn(`Could not determine extent for ${tableName}:`, err);
        }

        return undefined;
    }

    async getSchema(req: DuckDBRequest, collectionId: string): Promise<Record<string, unknown>> {
        const db = this.conn(req);
        const key = this.tenantKey(req);
        const tableName = this.physicalName(collectionId, key);

        const columns = await db.runAndReadAll(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ?
    `, [tableName]);

        const properties: Record<string, any> = {};

        const cols = columns.getRowObjectsJS();
        for (const col of cols) {
            properties[String(col['column_name'])] = {
                type: this.mapDuckDBTypeToJSON(String(col['data_type'])),
            };
        }

        return {
            type: 'object',
            properties,
        };
    }

    private mapDuckDBTypeToJSON(duckdbType: string): string {
        const type = duckdbType.toUpperCase();
        if (type.includes('INT') || type.includes('BIGINT')) return 'integer';
        if (type.includes('DOUBLE') || type.includes('FLOAT') || type.includes('DECIMAL')) return 'number';
        if (type.includes('BOOL')) return 'boolean';
        if (type.includes('GEOMETRY')) return 'object';
        return 'string';
    }

    async getFeatures(
        req: DuckDBRequest,
        collectionId: string,
        params: QueryParams
    ): Promise<FeatureCollection> {
        const db = this.conn(req);
        const key = this.tenantKey(req);
        const tableName = this.physicalName(collectionId, key);

        const limit = Math.min(params.limit || this.defaultLimit, this.maxLimit);
        const offset = params.offset || 0;

        const geometryColumn = await this.geometryColumn(db, tableName);

        let query = `SELECT *, `;

        if (geometryColumn) {
            query += `ST_AsGeoJSON(${this.quote(geometryColumn)}) as __geometry_json `;
        }

        query += `FROM ${this.quote(tableName)} `;

        // Add bbox filter if provided
        const bboxXY = this.bboxXY(params.bbox);
        if (bboxXY && geometryColumn) {
            const [minx, miny, maxx, maxy] = bboxXY;
            query += `WHERE ST_Intersects(${this.quote(geometryColumn)}, ST_MakeEnvelope(${minx}, ${miny}, ${maxx}, ${maxy})) `;
        }

        query += `LIMIT ${limit} OFFSET ${offset}`;

        const rows = await db.runAndReadAll(query);

        const features: Feature[] = rows.getRowObjectsJS().map((row) => this.rowToFeature(row, geometryColumn));

        return {
            type: 'FeatureCollection',
            features,
            numberMatched: await this.getFeatureCount(db, tableName, params),
            numberReturned: features.length,
        };
    }

    /** `tableName` is a physical (already-prefixed) name. */
    private async getFeatureCount(
        db: DuckDBConnection,
        tableName: string,
        params: QueryParams
    ): Promise<number> {
        let query = `SELECT COUNT(*) as count FROM ${this.quote(tableName)}`;

        const bboxXY = this.bboxXY(params.bbox);
        if (bboxXY) {
            const geometryColumn = await this.geometryColumn(db, tableName);

            if (geometryColumn) {
                const [minx, miny, maxx, maxy] = bboxXY;
                query += ` WHERE ST_Intersects(${this.quote(geometryColumn)}, ST_MakeEnvelope(${minx}, ${miny}, ${maxx}, ${maxy}))`;
            }
        }

        const reader = await db.runAndReadAll(query);
        return Number(reader.getRowObjectsJS()[0]?.count ?? 0);
    }

    async getFeature(
        req: DuckDBRequest,
        collectionId: string,
        featureId: string
    ): Promise<Feature | null> {
        const db = this.conn(req);
        const key = this.tenantKey(req);
        const tableName = this.physicalName(collectionId, key);

        const geometryColumn = await this.geometryColumn(db, tableName);

        let query = `SELECT *, `;

        if (geometryColumn) {
            query += `ST_AsGeoJSON(${this.quote(geometryColumn)}) as __geometry_json `;
        }

        const idCols = await this.idColumns(db, tableName);
        query += `FROM ${this.quote(tableName)} WHERE ${this.idClause(idCols)}`;

        const reader = await db.runAndReadAll(query, idCols.map(() => featureId));
        const row = reader.getRowObjectsJS()[0];

        if (!row) {
            return null;
        }

        return this.rowToFeature(row, geometryColumn);
    }

    async getQueryables(req: DuckDBRequest, collectionId: string): Promise<Queryable> {
        const schema = await this.getSchema(req, collectionId);

        return {
            type: 'object',
            title: `Queryables for ${collectionId}`,
            properties: schema.properties as Record<string, any>,
            $id: `/collections/${collectionId}/queryables`,
            $schema: 'https://json-schema.org/draft/2019-09/schema',
        };
    }

    async createFeature(req: DuckDBRequest, collectionId: string, feature: Feature): Promise<Feature | null> {
        const db = this.conn(req);
        const key = this.tenantKey(req);
        const tableName = this.physicalName(collectionId, key);

        const columns = Object.keys(feature.properties || {});
        const values = Object.values(feature.properties || {}) as DuckDBValue[];
        const placeholders = columns.map(() => '?');

        if (feature.geometry) {
            // Reuse the same column the read paths would discover, instead of
            // assuming it's literally named 'geometry' — GDAL/shapefile imports
            // commonly call it 'geom' or 'wkb_geometry'. Fall back to 'geometry'
            // only if the table doesn't have a recognizable spatial column yet.
            const geometryColumn = (await this.geometryColumn(db, tableName)) ?? 'geometry';
            columns.push(geometryColumn);
            placeholders.push('ST_GeomFromGeoJSON(?)');
            values.push(JSON.stringify(feature.geometry));
        }

        const query = `
      INSERT INTO ${this.quote(tableName)} (${columns.map((c) => this.quote(c)).join(', ')})
      VALUES (${placeholders.join(', ')})
      RETURNING *
    `;

        const reader = await db.runAndReadAll(query, values);
        const row = reader.getRowObjectsJS()[0];

        if (row) {
            const id = row.id ?? row.fid;
            return await this.getFeature(req, collectionId, String(id));
        }

        return null;
    }

    async replaceFeature(
        req: DuckDBRequest,
        collectionId: string,
        featureId: string,
        feature: Feature
    ): Promise<Feature | null> {
        const db = this.conn(req);
        const key = this.tenantKey(req);
        const tableName = this.physicalName(collectionId, key);

        const columns = Object.keys(feature.properties || {});
        const values = Object.values(feature.properties || {}) as DuckDBValue[];

        if (columns.length === 0) {
            // Nothing to set — SET with no assignments is invalid SQL. Leave the
            // row as-is and hand back its current state.
            return await this.getFeature(req, collectionId, featureId);
        }

        const idCols = await this.idColumns(db, tableName);
        const setClause = columns.map(col => `${this.quote(col)} = ?`).join(', ');

        const query = `
      UPDATE ${this.quote(tableName)}
      SET ${setClause}
      WHERE ${this.idClause(idCols)}
    `;

        await db.run(query, [...values, ...idCols.map(() => featureId)] as DuckDBValue[]);

        return await this.getFeature(req, collectionId, featureId);
    }

    async updateFeature(
        req: DuckDBRequest,
        collectionId: string,
        featureId: string,
        params: UpdateFeatureParams
    ): Promise<Feature | null> {
        const db = this.conn(req);
        const key = this.tenantKey(req);
        const tableName = this.physicalName(collectionId, key);

        const updates = params.feature.properties || {};
        const columns = Object.keys(updates);
        const values = Object.values(updates) as DuckDBValue[];

        if (columns.length === 0) {
            // Nothing to set — SET with no assignments is invalid SQL.
            return await this.getFeature(req, collectionId, featureId);
        }

        const idCols = await this.idColumns(db, tableName);
        const setClause = columns.map(col => `${this.quote(col)} = ?`).join(', ');

        const query = `
      UPDATE ${this.quote(tableName)}
      SET ${setClause}
      WHERE ${this.idClause(idCols)}
    `;

        await db.run(query, [...values, ...idCols.map(() => featureId)] as DuckDBValue[]);

        return await this.getFeature(req, collectionId, featureId);
    }

    async deleteFeature(req: DuckDBRequest, collectionId: string, featureId: string): Promise<boolean> {
        const db = this.conn(req);
        const key = this.tenantKey(req);
        const tableName = this.physicalName(collectionId, key);

        const idCols = await this.idColumns(db, tableName);
        const query = `DELETE FROM ${this.quote(tableName)} WHERE ${this.idClause(idCols)}`;
        const result = await db.run(query, idCols.map(() => featureId));

        return result.rowsChanged > 0;
    }

    addCollection(_collection: Collection): void {
        throw new Error('addCollection not supported by DuckDBProvider — create the table instead');
    }

    addFeature(_collectionId: string, _feature: Feature): void {
        // This would require creating the table structure dynamically
        throw new Error('addFeature not implemented for DuckDB provider');
    }
}
