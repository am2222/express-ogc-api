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
import type { Geometry } from 'geojson';
import { OGCAPIConformanceItem, OGCAPIConformanceClass } from '@/types/ogc-confirmance';
import { BaseProvider, type ProviderDef } from '@/providers/base-provider';
import { FeatureValidationError } from '@/errors';

export interface DuckDBLocals {
    db: DuckDBConnection;
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
     * Map a collection id to the physical table name to query. This is the
     * library's extension point for namespacing schemes (per-tenant table
     * prefixes, schema qualification, or anything else): every quoted table
     * reference and every `information_schema` lookup in this class calls
     * this method (or reuses a name it already produced) rather than using
     * `collectionId` directly.
     *
     * The default implementation is the identity: `collectionId` *is* the
     * table name. Override it to add a prefix or other mapping — but see
     * `collectionIdForTable`, its required inverse: whatever this method
     * does to go from collection id to table name, that method must undo,
     * or a client will be able to request a collection id that discovery
     * never advertised, or one request's mapping will resolve to a table
     * that belongs to a different tenant/request.
     */
    protected physicalTableName(_req: DuckDBRequest, collectionId: string): string {
        return collectionId;
    }

    /**
     * Map a discovered table name (as returned by `information_schema.tables`)
     * to the collection id it should be exposed as for this request, or
     * `null` to hide it from this request entirely. `discoverCollections`
     * maps every table it finds through this method and drops every `null`.
     *
     * The default implementation is the identity: every table is a
     * collection, named after itself. This must stay the exact inverse of
     * `physicalTableName`: for every collection id `c` a request should be
     * able to see, `collectionIdForTable(req, physicalTableName(req, c))`
     * must equal `c`. Breaking that symmetry — prefixing in one direction
     * without stripping in the other, say — means a client sees a
     * collection in `GET /collections` that then 404s when it tries to read
     * it, or, worse, silently resolves to a table outside what this request
     * should be able to reach.
     */
    protected collectionIdForTable(_req: DuckDBRequest, tableName: string): string | null {
        return tableName;
    }

    /**
     * Which of the conventional id columns ('id', 'fid') actually exist on the
     * table. DuckDB's binder rejects a WHERE clause that references a column
     * the table doesn't have, so a hardcoded `id = ? OR fid = ?` fails on any
     * table without a `fid` column — this discovers what is really there.
     * `tableName` is a physical table name (as produced by `physicalTableName`).
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
     * physical table name (as produced by `physicalTableName`).
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
     * `reader.getRowObjectsJS()` returns DuckDB `BIGINT`/`UBIGINT`/`HUGEINT`
     * columns as JS `bigint`, which `JSON.stringify` (used by `res.json()`)
     * cannot serialize at all — it throws. Normalise: within the safe integer
     * range, a plain `number` round-trips exactly; outside it, a decimal
     * string is lossy but at least doesn't crash the response. Every other
     * value passes through unchanged.
     */
    private normalizeValue(value: unknown): unknown {
        if (typeof value !== 'bigint') {
            return value;
        }
        return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(value)
            : value.toString();
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
        const properties: Record<string, unknown> = {};
        for (const [column, value] of Object.entries(rest)) {
            properties[column] = this.normalizeValue(value);
        }
        if (geometryColumn) {
            delete properties[geometryColumn];
        }

        // The cast is sound by construction: `__geometry_json` is only ever
        // projected as `ST_AsGeoJSON(...)`, whose output is a GeoJSON geometry
        // object. A parse failure leaves the feature unlocated (`null`) rather
        // than propagating a half-parsed value.
        let geometry: Geometry | null = null;
        if (__geometry_json) {
            try {
                geometry = JSON.parse(String(__geometry_json)) as Geometry;
            } catch (err) {
                console.warn('Failed to parse geometry:', err);
            }
        }

        // No longer an inaccurate cast: `properties.id`/`properties.fid` have
        // already had any bigint normalised to number/string above, so the
        // runtime value genuinely matches `string | number` for conventional
        // id columns.
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
            ...this.schemaConformanceClasses(),
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

        const reader = await db.runAndReadAll(`
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = current_schema()
                  AND table_schema NOT IN ('information_schema', 'pg_catalog')
                `);

        const collections: Collection[] = [];
        for (const row of reader.getRowObjectsJS()) {
            const tableName = String(row['table_name']);
            const collectionId = this.collectionIdForTable(req, tableName);
            if (collectionId === null) {
                continue;
            }
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
        const tableName = this.physicalTableName(req, collectionId);

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

    /** `tableName` is a physical table name (as produced by `physicalTableName`). */
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

    /**
     * Builds a JSON Schema (Part 5) describing the table's columns, carrying
     * every constraint DuckDB already knows about rather than just `{ type }`:
     * `enum` for an `ENUM` column, `required` for non-nullable columns,
     * `maxLength` where DuckDB reports a `character_maximum_length`,
     * `x-ogc-role` on the discovered geometry column (and, where unambiguous,
     * the id column) — matching what `InMemoryProvider.getSchema` already
     * emits for `x-ogc-role: 'primary-geometry'` — plus two keywords QGIS's
     * OGC API - Features provider actually parses: `x-ogc-propertySeq`
     * (the column's `ordinal_position`, so QGIS orders attribute-table
     * fields the way the table declares them) and `title` (a derived field
     * alias — see `titleFromColumnName`).
     *
     * Deliberately not emitted: `description` and `readOnly`. DuckDB has no
     * column-comment metadata readily available through
     * `information_schema.columns` here, and no column in a plain DuckDB
     * table is read-only, so there is nothing truthful to put in either
     * keyword — inventing values would be fabrication, not metadata.
     *
     * This is advisory metadata for clients, not enforcement: the provider
     * does not validate a request body against this schema before writing.
     * Enforcement is left to the database, whose rejections the write paths
     * below translate into `FeatureValidationError`.
     */
    async getSchema(req: DuckDBRequest, collectionId: string): Promise<Record<string, unknown>> {
        const db = this.conn(req);
        const tableName = this.physicalTableName(req, collectionId);

        const columns = await db.runAndReadAll(`
      SELECT column_name, data_type, is_nullable, character_maximum_length, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ?
    `, [tableName]);

        // Reuse the same discovery the read/write paths use, rather than
        // assuming the column is literally named 'geometry' — the two bundled
        // providers must agree on which column is "the" geometry column.
        const geometryColumn = await this.geometryColumn(db, tableName);

        // Mark an id column only when discovery is unambiguous: 'id' and 'fid'
        // are both conventional identifier names, and `idColumns` can return
        // both if a table happens to define both. When it does, there's no
        // clean way to say which one *is* the identifier, so the role is
        // omitted rather than guessed.
        const idCols = await this.idColumns(db, tableName);
        const idColumn = idCols.length === 1 ? idCols[0] : undefined;

        const properties: Record<string, any> = {};
        const required: string[] = [];

        const cols = columns.getRowObjectsJS();
        for (const col of cols) {
            const columnName = String(col['column_name']);
            const dataType = String(col['data_type']);

            const property: Record<string, unknown> = {};

            property.title = this.titleFromColumnName(columnName);

            const ordinalPosition = col['ordinal_position'];
            if (ordinalPosition !== null && ordinalPosition !== undefined) {
                property['x-ogc-propertySeq'] = Number(ordinalPosition);
            }

            const enumValues = this.parseEnumValues(dataType);
            if (enumValues) {
                property.type = 'string';
                property.enum = enumValues;
            } else {
                property.type = this.mapDuckDBTypeToJSON(dataType);
            }

            const maxLength = col['character_maximum_length'];
            if (maxLength !== null && maxLength !== undefined) {
                const n = Number(maxLength);
                if (Number.isFinite(n)) {
                    property.maxLength = n;
                }
            }

            if (geometryColumn && columnName === geometryColumn) {
                property['x-ogc-role'] = 'primary-geometry';
            } else if (idColumn && columnName === idColumn) {
                property['x-ogc-role'] = 'id';
            }

            properties[columnName] = property;

            if (String(col['is_nullable']).toUpperCase() === 'NO') {
                required.push(columnName);
            }
        }

        return {
            $schema: 'https://json-schema.org/draft/2019-09/schema',
            type: 'object',
            properties,
            required,
        };
    }

    /**
     * Parse DuckDB's rendering of an ENUM column's `data_type` — e.g.
     * `ENUM('asphalt', 'gravel', 'dirt')` — into its member values.
     *
     * DuckDB single-quotes each value and escapes an embedded quote by
     * doubling it (`''`); a value can also contain a comma. A naive
     * `split(',')` breaks on either, so this scans character-by-character
     * instead. Returns `undefined` — never a wrong or partial list — for
     * anything that doesn't parse cleanly as `ENUM(...)`, including a
     * malformed or unrecognised rendering.
     */
    private parseEnumValues(dataType: string): string[] | undefined {
        const match = /^ENUM\((.*)\)$/is.exec(dataType.trim());
        if (!match) {
            return undefined;
        }
        const body = match[1] ?? '';
        const values: string[] = [];
        let i = 0;
        const len = body.length;

        while (i < len) {
            while (i < len && /\s/.test(body[i]!)) i++;
            if (i >= len) break;
            if (body[i] !== "'") {
                return undefined; // expected a quoted value here
            }
            i++; // consume opening quote

            let value = '';
            let closed = false;
            while (i < len) {
                const ch = body[i];
                if (ch === "'") {
                    if (body[i + 1] === "'") {
                        value += "'";
                        i += 2;
                        continue;
                    }
                    i++; // consume closing quote
                    closed = true;
                    break;
                }
                value += ch;
                i++;
            }
            if (!closed) {
                return undefined; // unterminated quoted value
            }
            values.push(value);

            while (i < len && /\s/.test(body[i]!)) i++;
            if (i >= len) break;
            if (body[i] !== ',') {
                return undefined; // unexpected content between values
            }
            i++; // consume comma
        }

        return values;
    }

    private mapDuckDBTypeToJSON(duckdbType: string): string {
        const type = duckdbType.toUpperCase();
        // Spatial types are checked first: `POINT`, `POLYGON` and
        // `LINESTRING` all contain the substring `INT`/`POLY`-adjacent
        // characters that must not fall into the numeric branch below (a
        // `POINT` column was previously reported as `integer`, since
        // `'POINT'.includes('INT')` is true).
        if (
            type.includes('GEOMETRY') ||
            type.includes('POINT') ||
            type.includes('POLYGON') ||
            type.includes('LINESTRING')
        ) {
            return 'object';
        }
        if (type.includes('INT')) return 'integer';
        if (type.includes('DOUBLE') || type.includes('FLOAT') || type.includes('DECIMAL')) return 'number';
        if (type.includes('BOOL')) return 'boolean';
        return 'string';
    }

    async getFeatures(
        req: DuckDBRequest,
        collectionId: string,
        params: QueryParams
    ): Promise<FeatureCollection> {
        const db = this.conn(req);
        const tableName = this.physicalTableName(req, collectionId);

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

    /** `tableName` is a physical table name (as produced by `physicalTableName`). */
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
        const tableName = this.physicalTableName(req, collectionId);

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
        const tableName = this.physicalTableName(req, collectionId);

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

        let reader;
        try {
            reader = await db.runAndReadAll(query, values);
        } catch (err) {
            throw this.translateWriteError(err, feature.properties ?? {});
        }
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
        const tableName = this.physicalTableName(req, collectionId);

        const columns = Object.keys(feature.properties || {});
        const values = Object.values(feature.properties || {}) as DuckDBValue[];
        const setParts = columns.map((col) => `${this.quote(col)} = ?`);

        if (feature.geometry) {
            // Same handling as createFeature: target the geometry column the
            // table actually has, not a hardcoded name, so a submitted
            // geometry is never silently dropped from a PUT.
            const geometryColumn = (await this.geometryColumn(db, tableName)) ?? 'geometry';
            setParts.push(`${this.quote(geometryColumn)} = ST_GeomFromGeoJSON(?)`);
            values.push(JSON.stringify(feature.geometry));
        }

        if (setParts.length === 0) {
            // Nothing to set — SET with no assignments is invalid SQL. Leave the
            // row as-is and hand back its current state.
            return await this.getFeature(req, collectionId, featureId);
        }

        const idCols = await this.idColumns(db, tableName);
        const setClause = setParts.join(', ');

        const query = `
      UPDATE ${this.quote(tableName)}
      SET ${setClause}
      WHERE ${this.idClause(idCols)}
    `;

        try {
            await db.run(query, [...values, ...idCols.map(() => featureId)] as DuckDBValue[]);
        } catch (err) {
            throw this.translateWriteError(err, feature.properties ?? {});
        }

        return await this.getFeature(req, collectionId, featureId);
    }

    async updateFeature(
        req: DuckDBRequest,
        collectionId: string,
        featureId: string,
        params: UpdateFeatureParams
    ): Promise<Feature | null> {
        const db = this.conn(req);
        const tableName = this.physicalTableName(req, collectionId);

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

        try {
            await db.run(query, [...values, ...idCols.map(() => featureId)] as DuckDBValue[]);
        } catch (err) {
            throw this.translateWriteError(err, updates);
        }

        return await this.getFeature(req, collectionId, featureId);
    }

    async deleteFeature(req: DuckDBRequest, collectionId: string, featureId: string): Promise<boolean> {
        const db = this.conn(req);
        const tableName = this.physicalTableName(req, collectionId);

        const idCols = await this.idColumns(db, tableName);
        const query = `DELETE FROM ${this.quote(tableName)} WHERE ${this.idClause(idCols)}`;

        let result;
        try {
            result = await db.run(query, idCols.map(() => featureId));
        } catch (err) {
            throw this.translateWriteError(err, {});
        }

        return result.rowsChanged > 0;
    }

    /**
     * Translate a DuckDB write-time rejection into a `FeatureValidationError`
     * when the rejection is the *client's* fault, so `items-curd.ts` can
     * respond 400/409 instead of 500 with the database's internal wording.
     * Anything not recognised below is returned unchanged and still 500s —
     * this is a denylist-style translation of *known* client-fault shapes,
     * not an attempt to reclassify every possible DuckDB error.
     *
     * Classification (see the DuckDB error text this matches against):
     * - `Conversion Error` (a value that won't coerce to the column's type,
     *   e.g. an invalid enum member or a non-numeric string for a numeric
     *   column) → 400.
     * - `Constraint Error: NOT NULL constraint failed: ...` → 400, naming
     *   the property.
     * - `Constraint Error: CHECK constraint failed ...` → 400.
     * - `Constraint Error: Duplicate key ... violates primary key/unique
     *   constraint.` → 409 (a uniqueness conflict is a different feature
     *   already occupying that value, which is what 409 Conflict means —
     *   this applies to both primary-key and unique-constraint violations,
     *   regardless of which write method triggered it, since the message
     *   itself is what carries the meaning, not the call site).
     * - `Binder Error` naming a column that doesn't exist (either shape
     *   DuckDB uses: an `UPDATE ... SET` targeting an absent column, or an
     *   `INSERT` naming one) → 400, since the column names came from the
     *   client's request body. This is also what closes the "PUT to a
     *   geometryless table" 500: with no geometry column, `replaceFeature`
     *   emits `SET "geometry" = ...`, which DuckDB rejects with exactly this
     *   Binder Error shape.
     * - `Catalog Error` (missing table) and anything else are left alone —
     *   callers already resolve unknown collections before most write calls,
     *   and an unrecognised error shape should keep failing loudly as a 500
     *   rather than being silently mis-classified.
     */
    private translateWriteError(err: unknown, properties: Record<string, unknown>): unknown {
        if (!(err instanceof Error)) {
            return err;
        }
        const message = err.message;

        const conversionMatch = /^Conversion Error: Could not convert string '((?:[^']|'')*)' to \w+/.exec(message);
        if (conversionMatch) {
            const rawValue = conversionMatch[1]!.replace(/''/g, "'");
            const property = this.findPropertyByValue(properties, rawValue);
            return new FeatureValidationError(
                property
                    ? `Property "${property}" has a value that is not valid for its column.`
                    : 'A property value in the request could not be converted to its column type.',
                { property, status: 400, cause: err }
            );
        }
        if (message.startsWith('Conversion Error:')) {
            return new FeatureValidationError(
                'A property value in the request could not be converted to its column type.',
                { status: 400, cause: err }
            );
        }

        const notNullPrefix = 'Constraint Error: NOT NULL constraint failed: ';
        if (message.startsWith(notNullPrefix)) {
            const qualified = message.slice(notNullPrefix.length).trim();
            const property = qualified.includes('.') ? qualified.slice(qualified.lastIndexOf('.') + 1) : qualified;
            return new FeatureValidationError(`Property "${property}" is required and cannot be null.`, {
                property,
                status: 400,
                cause: err,
            });
        }

        if (message.startsWith('Constraint Error: CHECK constraint failed')) {
            return new FeatureValidationError('The submitted feature violates a constraint on this collection.', {
                status: 400,
                cause: err,
            });
        }

        const duplicateKeyMatch = /^Constraint Error: Duplicate key "([^"]+)" violates (primary key|unique) constraint\.$/.exec(
            message
        );
        if (duplicateKeyMatch) {
            const keyText = duplicateKeyMatch[1]!;
            // A composite key renders as `"a: 1, b: 2"` — only single-column
            // keys are unambiguous to name a property for.
            const separator = keyText.indexOf(': ');
            const property =
                !keyText.includes(', ') && separator !== -1 ? keyText.slice(0, separator) : undefined;
            const value = property !== undefined ? keyText.slice(separator + 2) : undefined;
            return new FeatureValidationError(
                property
                    ? `A feature with "${property}" = "${value}" already exists.`
                    : 'A feature with a conflicting key already exists.',
                { property, status: 409, cause: err }
            );
        }

        const updateColumnMatch = /^Binder Error: Referenced update column (\S+) not found in table!/.exec(message);
        if (updateColumnMatch) {
            const property = updateColumnMatch[1]!;
            return new FeatureValidationError(`Property "${property}" does not exist on this collection.`, {
                property,
                status: 400,
                cause: err,
            });
        }

        const insertColumnMatch = /^Binder Error: .*does not have a column with name "([^"]+)"/.exec(message);
        if (insertColumnMatch) {
            const property = insertColumnMatch[1]!;
            return new FeatureValidationError(`Property "${property}" does not exist on this collection.`, {
                property,
                status: 400,
                cause: err,
            });
        }

        return err;
    }

    /**
     * Best-effort match of a value called out in a DuckDB error message back
     * to the property that submitted it. Only returns a name when exactly one
     * submitted property carries that exact value — with zero or several
     * candidates it's not safe to guess, so the caller gets a generic message
     * instead of a wrong property name.
     */
    private findPropertyByValue(properties: Record<string, unknown>, rawValue: string): string | undefined {
        const matches = Object.entries(properties).filter(([, value]) => String(value) === rawValue);
        return matches.length === 1 ? matches[0]![0] : undefined;
    }

    addCollection(_collection: Collection): void {
        throw new Error('addCollection not supported by DuckDBProvider — create the table instead');
    }

    addFeature(_collectionId: string, _feature: Feature): void {
        // This would require creating the table structure dynamically
        throw new Error('addFeature not implemented for DuckDB provider');
    }
}
