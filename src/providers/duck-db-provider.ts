import type { DuckDBConnection, DuckDBValue, JS } from '@duckdb/node-api';

// biome-ignore assist/source/organizeImports: <explanation>
import type {
    Collection,
    CollectionSchema,
    CollectionSchemaProperty,
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
import { Cql2ToSql } from '@/cql2';
import { crsFromGeometryTypeName } from '@/providers/geometry-crs';

/** A WHERE clause (empty string when there is nothing to filter by) and the
 * values bound to its `?` placeholders, in the order they appear. `filter`
 * carries the original CQL2 `filter` text through to query execution — not
 * used to build SQL (that already happened in `buildPredicate`), only so a
 * DuckDB failure while running the query can be scoped to "a filter was
 * applied" and named back to the client without leaking generated SQL. */
interface Predicate {
    where: string;
    params: DuckDBValue[];
    filter: string | undefined;
}

export interface DuckDBLocals {
    db: DuckDBConnection;
}

export interface DuckDBProviderDef extends ProviderDef {}

type DuckDBRequest = ProviderRequest<Record<string, string>, DuckDBLocals>;

/** Shared empty set for the `timeColumns`/`dateColumns` default parameters — avoids allocating a new one per call that doesn't need it. */
const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Quote a SQL single-quoted string literal. Used for CRS identifiers, which
 * are interpolated rather than bound because `ST_Transform`'s CRS arguments
 * have to be constant-foldable, not parameters.
 */
function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A pair of CRS identifiers in a form PROJ accepts (`'EPSG:25832'`,
 * `'OGC:CRS84'`, a PROJ string), describing how a collection's stored
 * coordinates relate to the coordinates the API speaks.
 *
 * `DuckDBProvider` never produces one — `geometryTransform` returns
 * `undefined`, so every geometry expression stays exactly as it was. A
 * subclass whose storage CRS differs from the CRS it advertises returns one
 * (see `DuckLakeProvider`), which turns on `ST_Transform` on both the read
 * and the write path.
 */
export interface GeometryTransform {
    /** CRS the geometry is stored in. */
    storage: string;
    /** CRS the API reads and writes in — CRS84 for a spec-conformant server. */
    api: string;
}

export class DuckDBProvider extends BaseProvider<Record<string, string>, DuckDBLocals> {
    public override readonly enableSchemas = true;
    public override readonly enableFiltering = true;
    public override readonly enableTransactions = true;

    /**
     * Cap on how many ENUM members `invalidPropertyValueMessage` lists in a
     * 400 body. See that method's docstring for why 20.
     */
    private static readonly MAX_ENUM_VALUES_IN_MESSAGE = 20;

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
    protected conn(req: DuckDBRequest): DuckDBConnection {
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
    protected quote(identifier: string): string {
        if (identifier.includes('\0')) {
            throw new Error(`Invalid identifier: ${identifier}`);
        }
        return `"${identifier.replace(/"/g, '""')}"`;
    }

    /**
     * The CRS pair to reproject between for this table, or `undefined` for
     * none (the default — coordinates are served exactly as stored).
     *
     * Resolved once per query by the callers below and threaded into every
     * geometry expression they build, so a subclass only has to answer "what
     * CRS is this table in?" rather than reimplement query construction.
     */
    protected async geometryTransform(
        _req: DuckDBRequest,
        _tableName: string
    ): Promise<GeometryTransform | undefined> {
        return undefined;
    }

    /**
     * Wrap a *stored* geometry expression so it comes out in the API's CRS —
     * used for anything the client will see or compare against: GeoJSON
     * output, collection extents, and the geometry side of a spatial
     * predicate.
     *
     * `always_xy` is not optional here. EPSG:4326 declares latitude first, so
     * without it `ST_Transform` emits `POINT(lat lon)` and every coordinate
     * in the response is silently swapped — GeoJSON is always
     * longitude-first.
     */
    protected toApiCrs(expression: string, transform: GeometryTransform | undefined): string {
        if (!transform) {
            return expression;
        }
        return `ST_Transform(${expression}, ${quoteLiteral(transform.storage)}, ${quoteLiteral(transform.api)}, always_xy := true)`;
    }

    /**
     * Wrap a geometry expression that arrived from the *client* (in the API's
     * CRS) so it can be stored — the inverse of `toApiCrs`, used on the write
     * path.
     */
    protected toStorageCrs(expression: string, transform: GeometryTransform | undefined): string {
        if (!transform) {
            return expression;
        }
        return `ST_Transform(${expression}, ${quoteLiteral(transform.api)}, ${quoteLiteral(transform.storage)}, always_xy := true)`;
    }

    /**
     * The CRS declared by the geometry column's own type, or `undefined`.
     *
     * As of the spatial extension shipped with DuckDB 1.5, `GEOMETRY` is a
     * parameterized type and a CRS-carrying column reports its data type as
     * `GEOMETRY('EPSG:25832')`. That makes the column type the authoritative
     * place to look — this is the same value `ST_CRS(geom)` returns for a row
     * of that column, but read from catalog metadata instead of from data, so
     * it costs no table scan (which on an object-store-backed table means no
     * S3 fetch just to answer "what projection is this?").
     *
     * Returns `undefined` for a plain `GEOMETRY` column, which is not the same
     * as "unprojected" — it means the column simply does not say. Note also
     * that the CRS belongs to the *column type*, not to individual values:
     * inserting an `ST_SetCRS(...)` value into a plain `GEOMETRY` column
     * discards it.
     */
    protected async declaredGeometryCrs(
        db: DuckDBConnection,
        tableName: string,
        geometryColumn: string
    ): Promise<string | undefined> {
        const reader = await db.runAndReadAll(
            `SELECT data_type FROM duckdb_columns()
             WHERE database_name = current_database() AND schema_name = current_schema()
               AND table_name = ? AND column_name = ?`,
            [tableName, geometryColumn]
        );
        const dataType = reader.getRowObjectsJS()[0]?.['data_type'];
        if (dataType == null) {
            return undefined;
        }
        return crsFromGeometryTypeName(String(dataType));
    }

    /**
     * Reproject the geometry column wherever a translated CQL2 filter
     * references it, so spatial predicates compare like-for-like against
     * client geometries in the API's CRS.
     *
     * Applied to `Cql2ToSql`'s *finished* SQL rather than through its patch
     * list, because a patch runs too early to work: property names are still
     * sentinels (`cql2id0`) at patch time and only become quoted identifiers
     * in the final `resolveSentinels` pass.
     *
     * Rewriting the identifier token in finished SQL is safe precisely
     * because that pass has already run: every string literal has been
     * replaced by a bound `?`, so a filter comparing a text column to the
     * literal string `"geometry"` contributes no such token to the SQL. The
     * only occurrences left are genuine references to the column.
     */
    protected projectGeometryReferences(
        sql: string,
        geometryColumn: string,
        transform: GeometryTransform | undefined
    ): string {
        if (!transform) {
            return sql;
        }
        const quoted = this.quote(geometryColumn);
        return sql.split(quoted).join(this.toApiCrs(quoted, transform));
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
    protected async idColumns(db: DuckDBConnection, tableName: string): Promise<string[]> {
        const reader = await db.runAndReadAll(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_catalog = current_database() AND table_schema = current_schema() AND table_name = ? AND column_name IN ('id', 'fid')
            `, [tableName]);
        return reader.getRowObjectsJS().map((row) => String(row['column_name']));
    }

    /** Build `"id" = ? OR "fid" = ?` for whichever id columns are present. */
    protected idClause(columns: string[]): string {
        if (columns.length === 0) {
            throw new Error(`Collection has no 'id' or 'fid' column to identify features by`);
        }
        return columns.map((col) => `${this.quote(col)} = ?`).join(' OR ');
    }

    /**
     * The name of the table's identifier column, but only when it can
     * actually assign a value on INSERT — i.e. it has a column default (a
     * sequence via `DEFAULT nextval('...')`, or any other default
     * expression) — and only when identifier discovery is unambiguous (see
     * `idColumns`/`idColumn` in `getSchema`: 'id' and 'fid' are both
     * conventional names, and if a table happens to define both there's no
     * clean way to say which one is *the* identifier, so this backs off
     * rather than guessing).
     *
     * `column_default` is read from `information_schema.columns` — probed
     * directly against a `DEFAULT nextval('seq')` column and confirmed to
     * render the default expression (e.g. `"nextval('demo_points_id_seq')"`)
     * there, `NULL` for a column with no default. `duckdb_columns()` (the
     * source `getSchema`/`temporalColumnKinds` otherwise prefer for other
     * metadata) exposes the identical value under the same column name, so
     * either would work here; `information_schema.columns` is used because
     * every other identifier-related lookup in this class (`idColumns`,
     * `columnNames`) already reads that view, and there is no other metadata
     * this call needs that only `duckdb_columns()` carries.
     *
     * `createFeature` uses this to omit a client-supplied value for this
     * column from the INSERT column list, so the database's own default
     * fires — a literal value in an `INSERT` always beats a column
     * `DEFAULT`, so simply having the default declared is not enough by
     * itself. `tableName` is a physical table name (as produced by
     * `physicalTableName`).
     */
    protected async idColumnWithDefault(
        db: DuckDBConnection,
        tableName: string,
        idCols: string[]
    ): Promise<string | undefined> {
        if (idCols.length !== 1) {
            return undefined;
        }
        const column = idCols[0]!;
        const reader = await db.runAndReadAll(`
            SELECT column_default
            FROM information_schema.columns
            WHERE table_catalog = current_database() AND table_schema = current_schema() AND table_name = ? AND column_name = ?
            `, [tableName, column]);
        const row = reader.getRowObjectsJS()[0];
        if (!row) {
            return undefined;
        }
        const columnDefault = row['column_default'];
        // A DuckLake-backed catalog renders "no default" as the *string*
        // `'NULL'` rather than SQL NULL (plain DuckDB gives SQL NULL). A bare
        // `!= null` test therefore reads every DuckLake column as
        // self-assigning, which would make `createFeature` drop the client's
        // id from the INSERT for a column that has nothing to fall back on —
        // writing a NULL identifier instead of the value that was sent. An
        // explicit `DEFAULT NULL` in plain DuckDB means the same thing as no
        // default, so treating both spellings as "no default" is correct on
        // either backend.
        if (columnDefault == null || String(columnDefault).trim().toUpperCase() === 'NULL') {
            return undefined;
        }
        return column;
    }

    /**
     * Every column name on a table — the `allowedProperties` a `Cql2ToSql`
     * instance needs so an unknown queryable in a `filter` is rejected with a
     * clean `UNKNOWN_PROPERTY` (→ 400) instead of reaching the database as a
     * raw identifier and failing as a Binder Error. Includes the geometry
     * column deliberately: a spatial predicate (`S_INTERSECTS`, `S_WITHIN`,
     * ...) has to be able to name it.
     *
     * A light `information_schema.columns` lookup — the same shape as
     * `idColumns`/`geometryColumn` above — not a call into `getSchema`:
     * `getSchema`'s geometry-format discovery runs a full table scan, and
     * this runs on every `getFeatures`/`getFeatureCount` call, a per-request
     * path `getSchema` is documented not to be on. `tableName` is a physical
     * table name (as produced by `physicalTableName`).
     */
    private async columnNames(db: DuckDBConnection, tableName: string): Promise<string[]> {
        const reader = await db.runAndReadAll(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_catalog = current_database() AND table_schema = current_schema() AND table_name = ?
            `, [tableName]);
        return reader.getRowObjectsJS().map((row) => String(row['column_name']));
    }

    /**
     * The combined WHERE predicate for `bbox` and CQL2 `filter` — built once
     * per request and handed to both `getFeatures` and `getFeatureCount` so
     * they can never disagree. `getFeatureCount` backs `numberMatched`, which
     * backs the `next`/`prev` pagination links; if it applied a different
     * predicate than the features query, the reported total (and therefore
     * pagination) would be wrong on every filtered page.
     *
     * The bbox clause's bounds are plain numbers (already parsed and typed by
     * `bboxXY`/`QueryParams.bbox`), so they're safe to inline the same way the
     * pre-existing bbox-only code did. The CQL2 filter is translated by
     * `Cql2ToSql`, which returns `?` placeholders with a parallel bound-values
     * array — those are appended to `params`, never interpolated into the
     * SQL text. A `Cql2Error` (`PARSE_ERROR` / `UNSUPPORTED_OP` /
     * `UNKNOWN_PROPERTY`) from a malformed or disallowed filter propagates
     * out of this method uncaught; `items-curd.ts` maps it to a 400.
     *
     * `tableName` is a physical table name (as produced by `physicalTableName`).
     */
    private async buildPredicate(
        db: DuckDBConnection,
        tableName: string,
        geometryColumn: string | undefined,
        params: QueryParams,
        transform?: GeometryTransform
    ): Promise<Predicate> {
        const clauses: string[] = [];
        const boundParams: DuckDBValue[] = [];

        const bboxXY = this.bboxXY(params.bbox);
        if (bboxXY && geometryColumn) {
            const [minx, miny, maxx, maxy] = bboxXY;
            // The *column* is reprojected into the API's CRS rather than the
            // envelope into storage CRS. Transforming the envelope would be
            // cheaper (constant-folded once, and it leaves the stored column
            // available for statistics-based pruning), but a lon/lat rectangle
            // does not stay a rectangle under reprojection, so its transformed
            // corner envelope is only an approximation of the real query area
            // — near the edges that both admits and drops features. This way
            // `bbox` means exactly what it says, and matches how the CQL2 path
            // below interprets client geometries.
            clauses.push(
                `ST_Intersects(${this.toApiCrs(this.quote(geometryColumn), transform)}, ST_MakeEnvelope(${minx}, ${miny}, ${maxx}, ${maxy}))`
            );
        }

        if (params.filter) {
            const allowedProperties = await this.columnNames(db, tableName);
            const translator = new Cql2ToSql({ allowedProperties });
            const { sql, params: filterParams } = translator.toSql(params.filter, params.filterLang);
            // A CQL2 spatial predicate's geometry literals are in the API's CRS
            // (CRS84), so the column they are compared against is reprojected to
            // match.
            const projected = geometryColumn
                ? this.projectGeometryReferences(sql, geometryColumn, transform)
                : sql;
            clauses.push(`(${projected})`);
            boundParams.push(...(filterParams as DuckDBValue[]));
        }

        return {
            where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
            params: boundParams,
            filter: params.filter,
        };
    }

    /**
     * A defensive net for a filter `Cql2ToSql` accepts but that still can't
     * run as a `WHERE` predicate — e.g. `category ===`, which `cql2-rs`
     * parses leniently (discarding the malformed tail) into a bare,
     * non-boolean property reference rather than throwing. `Cql2ToSql` never
     * sees an error in that case, so the `Cql2Error` → 400 mapping in
     * `items-curd.ts` never fires, and without this the resulting DuckDB
     * `Conversion Error`/`Binder Error` would 500 with raw SQL and internal
     * column names in the body.
     *
     * Scoped narrowly on purpose:
     *   - Only fires when `predicateFilter` is set — i.e. a `filter` was
     *     actually applied to this query. An unfiltered request hitting a
     *     genuine server fault (missing table, connection failure, anything
     *     else) must keep its 500 exactly as before; only ever passing this
     *     the request's own filter text (`params.filter`, not something
     *     derived from `err`) is what keeps that guarantee intact regardless
     *     of what the error looks like.
     *   - Only recognises the two DuckDB error shapes a bad-but-accepted
     *     filter is known to produce (`Conversion Error`, `Binder Error`).
     *     Anything else — `Catalog Error`, a connection drop, an internal
     *     driver fault — is returned unchanged and still 500s.
     *
     * The resulting message names the filter the client submitted (that's
     * exactly what they sent — nothing new is disclosed) but never the
     * generated SQL or a physical column/table name.
     */
    private translateFilterQueryError(err: unknown, predicateFilter: string | undefined): unknown {
        if (!predicateFilter || !(err instanceof Error)) {
            return err;
        }
        if (err.message.startsWith('Conversion Error:') || err.message.startsWith('Binder Error:')) {
            return new FeatureValidationError(
                `The filter could not be applied: ${predicateFilter}`,
                { status: 400, cause: err }
            );
        }
        return err;
    }

    /**
     * The geometry column of a table, if any. `broad` widens the match beyond
     * `GEOMETRY` to the specific spatial types too (used for extent discovery,
     * where the column may not literally be typed `GEOMETRY`). `tableName` is a
     * physical table name (as produced by `physicalTableName`).
     */
    protected async geometryColumn(
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
            WHERE table_catalog = current_database() AND table_schema = current_schema() AND table_name = ? AND ${typeCondition}
            LIMIT 1
            `, [tableName]);

        const row = reader.getRowObjectsJS()[0];
        return row ? String(row['column_name']) : undefined;
    }

    /**
     * Remove a `properties` entry whose key exactly matches the *discovered*
     * geometry column name, returning a shallow copy (`properties` itself is
     * never mutated).
     *
     * QGIS's OGC API - Features Part 5 client reads the geometry column from
     * `GET /collections/{id}/schema` — correctly tagged there
     * `x-ogc-role: 'primary-geometry'` inside `properties`, which is what
     * lets QGIS identify it — but then treats that column as an ordinary
     * attribute field too, and round-trips a same-named (typically `null`)
     * entry inside `properties` on create/replace/update, alongside the real
     * top-level GeoJSON `geometry`. The top-level member is the sole
     * authority for geometry: a same-named `properties` entry is a client
     * artifact, not a second, competing value for the same column. Left
     * unstripped, it either duplicates the column in an INSERT's column list
     * (DuckDB rejects that outright: `Binder Error: Duplicate column name
     * "..." in INSERT`) or, on an UPDATE/PATCH, silently overwrites a
     * geometry the client never intended to touch.
     *
     * Matched against `geometryColumn` — the name discovery actually
     * resolved to (`geom`, `wkb_geometry`, ... whatever the table really
     * calls it) — never the literal string `'geometry'`, since a table
     * happening to have an unrelated property genuinely named `geometry`
     * would otherwise be impossible to distinguish from this. And only when
     * that exact key is present: an unrelated property that happens to be
     * `null` is left completely untouched.
     */
    protected stripDiscoveredGeometryProperty(
        properties: Record<string, unknown>,
        geometryColumn: string | undefined
    ): Record<string, unknown> {
        if (!geometryColumn || !(geometryColumn in properties)) {
            return properties;
        }
        const { [geometryColumn]: _omitted, ...rest } = properties;
        return rest;
    }

    /**
     * Which columns of a table are declared `TIME` and which are declared
     * `DATE` — the two DuckDB temporal types whose default JS/JSON
     * representation needs correcting before a feature is served (see
     * `rowToFeature`/`normalizeValue`). Both arrive from `getRowObjectsJS()`
     * in a form that, taken alone, can't be told apart from a type that
     * should serialize differently (`TIME` is a bare `bigint`, indistinguishable
     * by value from a genuine `BIGINT` column; `DATE` is a `Date`,
     * indistinguishable by value from a `TIMESTAMP`/`TIMESTAMP WITH TIME
     * ZONE`'s `Date`, which must NOT get the `DATE` treatment). So the
     * column's declared type has to come from schema metadata, not the value.
     *
     * One query covers both `TIME` and `DATE`, rather than two separate
     * one-type queries, since both are exact-string matches against
     * `duckdb_columns().data_type` (DuckDB's own rendering of `TIME` and
     * `DATE` are each a fixed, unambiguous string — no substring-ordering
     * pitfall here the way there is in `mapDuckDBType`).
     *
     * Read via `duckdb_columns()`, not `information_schema.columns` —
     * `duckdb_columns()` is already the source of truth for `getSchema` (see
     * there for why). `tableName` is a physical table name (as produced by
     * `physicalTableName`).
     */
    private async temporalColumnKinds(
        db: DuckDBConnection,
        tableName: string
    ): Promise<{ timeColumns: Set<string>; dateColumns: Set<string> }> {
        const reader = await db.runAndReadAll(`
            SELECT column_name, data_type
            FROM duckdb_columns()
            WHERE database_name = current_database() AND schema_name = current_schema()
              AND table_name = ? AND data_type IN ('TIME', 'DATE')
            `, [tableName]);

        const timeColumns = new Set<string>();
        const dateColumns = new Set<string>();
        for (const row of reader.getRowObjectsJS()) {
            const columnName = String(row['column_name']);
            if (row['data_type'] === 'TIME') {
                timeColumns.add(columnName);
            } else {
                dateColumns.add(columnName);
            }
        }
        return { timeColumns, dateColumns };
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
     * string is lossy but at least doesn't crash the response.
     *
     * `BLOB` columns arrive as a `Uint8Array` (in practice a Node `Buffer`,
     * which is a `Uint8Array` subclass), and `JSON.stringify` renders that as
     * `{"0":65,"1":66,...}` — technically valid JSON, but useless to a
     * client. Base64 is what `contentEncoding: 'base64'` in `getSchema`
     * advertises, so that's what every `Uint8Array` value is turned into
     * here. This check needs no column-type context: the only column that
     * reaches `rowToFeature`'s `properties` as a raw binary value is a BLOB
     * column — the geometry column (also WKB/`Uint8Array` at the JS binding
     * layer) is stripped out of `properties` before normalisation ever sees
     * it (see `rowToFeature` below).
     *
     * `TIME` columns arrive as a `bigint` too — microseconds since
     * midnight — indistinguishable *by value* from a genuine `BIGINT`
     * column. `DATE` columns arrive as a `Date`, indistinguishable *by
     * value* from a `TIMESTAMP`/`TIMESTAMP WITH TIME ZONE`'s `Date` (both are
     * plain JS `Date` instances; nothing about the object says which SQL type
     * produced it). Neither ambiguity can be resolved from the value alone,
     * so the caller must say which kind of column this is (`columnKind`);
     * everything else — a `bigint` from a non-`TIME` column, a `Date` from a
     * non-`DATE` column — falls through to the pre-existing handling below
     * (safe-range BIGINT normalisation, or an unmodified `Date` that
     * `JSON.stringify` renders as a full ISO instant, which is exactly right
     * for `TIMESTAMP`/`TIMESTAMP WITH TIME ZONE`).
     */
    private normalizeValue(value: unknown, columnKind?: 'time' | 'date'): unknown {
        if (value instanceof Uint8Array) {
            return Buffer.from(value).toString('base64');
        }
        if (columnKind === 'date' && value instanceof Date) {
            return this.dateToYMD(value);
        }
        if (typeof value !== 'bigint') {
            return value;
        }
        if (columnKind === 'time') {
            return this.microsToTimeString(value);
        }
        // Deliberate trade-off, not an oversight: `getSchema` declares this
        // column `type: 'integer'` (QGIS needs a numeric type to treat the
        // field as numeric — widening the declared type to
        // `['integer','string']` to accommodate the rare beyond-2^53 case
        // would likely confuse QGIS for the common case, in exchange for
        // correctly describing a rare one). So above `Number.MAX_SAFE_INTEGER`
        // the *value*'s JSON type is allowed to disagree with the *declared*
        // schema type: a decimal string, which at least round-trips the exact
        // digits for a client that reads it as text. The alternatives are
        // both worse — a `Number` here would silently lose precision, and
        // returning the raw `bigint` would crash `JSON.stringify` outright.
        // Do not "fix" this by changing the declared type or by returning a
        // `Number`; if it needs revisiting, that's a product decision to make
        // deliberately, not a bug to patch here.
        return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(value)
            : value.toString();
    }

    /**
     * Format a `DATE` column's JS `Date` value (as produced by
     * `getRowObjectsJS()`) as an RFC 3339 full-date string (`YYYY-MM-DD`),
     * matching the `format: 'date'` `getSchema` declares for a `DATE`
     * column. `JSON.stringify`'s default `Date` -> ISO-instant rendering
     * (`...T00:00:00.000Z`) is correct for `TIMESTAMP`/`TIMESTAMP WITH TIME
     * ZONE` (declared `format: 'date-time'`) but wrong here: handing a client
     * a full timestamp string where the schema promises a bare date is
     * self-contradictory, and QGIS in particular maps `format: 'date'` to a
     * date field, so it would be parsing a datetime string into it.
     *
     * Uses the UTC getters, not local ones. DuckDB's `DATE` type has no
     * time-of-day or timezone component, and `@duckdb/node-api` represents it
     * as a `Date` at UTC midnight (e.g. `1867-05-19T00:00:00.000Z`) — reading
     * that back with `getFullYear()`/`getMonth()`/`getDate()` (local time) on
     * a machine west of UTC would see the previous local day and silently
     * shift every `DATE` value back by one.
     */
    private dateToYMD(date: Date): string {
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        return `${String(year).padStart(4, '0')}-${month}-${day}`;
    }

    /**
     * Convert DuckDB's `TIME` representation — a `bigint` count of
     * microseconds since midnight (e.g. `45045000000n` for `12:30:45`) — into
     * an ISO-8601 time-of-day string (`HH:MM:SS`, with a fractional-seconds
     * suffix only when the value actually carries one), matching the
     * `format: 'time'` `getSchema` now advertises for `TIME` columns.
     *
     * Defensively wraps a negative or >=24h value into `[0, 86400000000)`
     * rather than emitting an out-of-range or negative clock string —
     * DuckDB's own `TIME` type shouldn't produce one, but this keeps the
     * output well-formed even if it ever does.
     */
    private microsToTimeString(micros: bigint): string {
        const microsPerSecond = 1_000_000n;
        const microsPerDay = 86_400n * microsPerSecond;

        let normalized = micros % microsPerDay;
        if (normalized < 0n) {
            normalized += microsPerDay;
        }

        const totalSeconds = normalized / microsPerSecond;
        const fractionMicros = normalized % microsPerSecond;

        const hours = totalSeconds / 3600n;
        const minutes = (totalSeconds % 3600n) / 60n;
        const seconds = totalSeconds % 60n;

        const pad2 = (n: bigint) => n.toString().padStart(2, '0');
        let result = `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;

        if (fractionMicros !== 0n) {
            const fraction = fractionMicros.toString().padStart(6, '0').replace(/0+$/, '');
            result += `.${fraction}`;
        }

        return result;
    }

    /**
     * Build a `Feature` from a raw row. Strips the internal `__geometry_json`
     * projection column and the raw geometry column itself out of `properties`
     * — without the latter, DuckDB's raw WKB `Uint8Array`/`Buffer` for the
     * geometry ends up serialized into every feature's properties alongside the
     * parsed GeoJSON geometry.
     */
    private rowToFeature(
        row: Record<string, JS>,
        geometryColumn: string | undefined,
        timeColumns: ReadonlySet<string> = EMPTY_SET,
        dateColumns: ReadonlySet<string> = EMPTY_SET
    ): Feature {
        const { __geometry_json, ...rest } = row;
        const properties: Record<string, unknown> = {};
        for (const [column, value] of Object.entries(rest)) {
            const columnKind = timeColumns.has(column) ? 'time' : dateColumns.has(column) ? 'date' : undefined;
            properties[column] = this.normalizeValue(value, columnKind);
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
                WHERE table_catalog = current_database() AND table_schema = current_schema()
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
                extent: await this.getTableExtent(
                    db,
                    tableName,
                    await this.geometryTransform(req, tableName)
                ),
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
            WHERE table_catalog = current_database() AND table_schema = current_schema() AND table_name = ?
            `, [tableName]);

        if (reader.getRowObjectsJS().length === 0) {
            return null;
        }

        return {
            id: collectionId,
            title: collectionId,
            description: `Collection from table ${collectionId}`,
            extent: await this.getTableExtent(
                db,
                tableName,
                await this.geometryTransform(req, tableName)
            ),
            itemType: 'feature',
            crs: [this.defaultCrs],
        };
    }

    /** `tableName` is a physical table name (as produced by `physicalTableName`). */
    private async getTableExtent(
        db: DuckDBConnection,
        tableName: string,
        transform?: GeometryTransform
    ): Promise<any> {
        try {
            const geometryColumn = await this.geometryColumn(db, tableName, true);

            if (geometryColumn) {
                // Reprojected before aggregating, so `extent.spatial.crs`
                // (always the API's default CRS) describes the numbers actually
                // reported.
                const geometryExpression = this.toApiCrs(this.quote(geometryColumn), transform);

                // `ST_Extent_Agg`, not `ST_Extent`: as of the spatial 2.x that
                // ships with DuckDB 1.5, `ST_Extent` is a *scalar* returning one
                // bounding box per geometry, so the aggregate-shaped query it
                // used to be spelled as yields one row per feature and reading
                // row 0 reports a single arbitrary feature's box as the whole
                // collection's extent. `ST_Extent_Agg` is the aggregate form.
                const extent = await db.runAndReadAll(`
          SELECT
            ST_XMin(ST_Extent_Agg(${geometryExpression})) as minx,
            ST_YMin(ST_Extent_Agg(${geometryExpression})) as miny,
            ST_XMax(ST_Extent_Agg(${geometryExpression})) as maxx,
            ST_YMax(ST_Extent_Agg(${geometryExpression})) as maxy
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
     * `format` for `DATE`/`TIME`/`TIMESTAMP`/`TIMESTAMP WITH TIME
     * ZONE`/`UUID` columns and for the discovered geometry column (see
     * `geometryFormat`), `contentEncoding: 'base64'` for a `BLOB` column
     * (matching how `normalizeValue` now serializes one), `description` from
     * a DuckDB column comment when one exists, `x-ogc-role` on the
     * discovered geometry column (and, where unambiguous, the id column) —
     * matching what `InMemoryProvider.getSchema` already emits for
     * `x-ogc-role: 'primary-geometry'` — plus two keywords QGIS's OGC API -
     * Features provider actually parses: `x-ogc-propertySeq` (the column's
     * ordinal position, so QGIS orders attribute-table fields the way the
     * table declares them) and `title` (a derived field alias — see
     * `titleFromColumnName`).
     *
     * Column metadata comes from `duckdb_columns()`, not
     * `information_schema.columns`: the latter has no `comment` column at
     * all, and `duckdb_columns()` already carries everything the old query
     * did (`column_name`, `data_type`, `is_nullable`, ordinal position as
     * `column_index`, and `character_maximum_length`), so one query replaces
     * what used to need a join.
     *
     * `readOnly: true` is emitted on the id column, but only when
     * `idColumnWithDefault` (the same predicate `createFeature` uses to
     * decide whether to omit a client-supplied id from its INSERT) says the
     * column has a database default. That is exactly when the server — not
     * the client — assigns the value on create: OGC API - Features Part 4
     * says the feature id is server-assigned and read-only, and Part 5's
     * `readOnly` is what QGIS's schema parser reads to grey the field out in
     * its create form. An id column with no default gets no `readOnly`
     * (and stays in `required`, see below): the server can't invent an id
     * for it, so the client still has to supply one, and marking it
     * read-only would tell a well-behaved client not to send the one value
     * that makes create work. Kept in sync with `required` deliberately —
     * the same column can never be both `readOnly` and `required`, since a
     * client could satisfy neither.
     *
     * This adds one extra query beyond the previous version — `geometryFormat`'s
     * `SELECT DISTINCT ST_GeometryType(...)` scan of the geometry column,
     * run only when the table has one. Acceptable here: `/schema` is not a
     * hot path the way `/items` is, and this never runs per-feature.
     *
     * This is advisory metadata for clients, not enforcement: the provider
     * does not validate a request body against this schema before writing.
     * Enforcement is left to the database, whose rejections the write paths
     * below translate into `FeatureValidationError`.
     */
    async getSchema(req: DuckDBRequest, collectionId: string): Promise<CollectionSchema> {
        const db = this.conn(req);
        const tableName = this.physicalTableName(req, collectionId);

        const columns = await db.runAndReadAll(`
      SELECT column_name, data_type, is_nullable, character_maximum_length, column_index, comment
      FROM duckdb_columns()
      WHERE database_name = current_database() AND schema_name = current_schema() AND table_name = ?
    `, [tableName]);

        // Reuse the same discovery the read/write paths use, rather than
        // assuming the column is literally named 'geometry' — the two bundled
        // providers must agree on which column is "the" geometry column.
        const geometryColumn = await this.geometryColumn(db, tableName);
        const geometryFormat = geometryColumn ? await this.geometryFormat(db, tableName, geometryColumn) : undefined;

        // Mark an id column only when discovery is unambiguous: 'id' and 'fid'
        // are both conventional identifier names, and `idColumns` can return
        // both if a table happens to define both. When it does, there's no
        // clean way to say which one *is* the identifier, so the role is
        // omitted rather than guessed.
        const idCols = await this.idColumns(db, tableName);
        const idColumn = idCols.length === 1 ? idCols[0] : undefined;

        // A column with a database default (see `createFeature`'s use of
        // this for the same reason) is one the *server* can and will supply
        // on create — `required` in this schema is read by clients (QGIS
        // included) to decide which fields a create form must collect from
        // the user before submitting. Leaving a server-assigned id in
        // `required` would tell a well-behaved client to demand a value the
        // server is going to discard anyway (see `createFeature`), which is
        // actively wrong now, not merely redundant. `is_nullable` alone
        // can't distinguish this: the column is still `NOT NULL` at the
        // storage layer (that's what makes it usable as a primary key) —
        // the database default is what changes whether the *client* still
        // has to provide it.
        const assignedIdColumn = await this.idColumnWithDefault(db, tableName, idCols);

        const properties: Record<string, CollectionSchemaProperty> = {};
        const required: string[] = [];

        const cols = columns.getRowObjectsJS();
        for (const col of cols) {
            const columnName = String(col['column_name']);
            const dataType = String(col['data_type']);

            const property: CollectionSchemaProperty = {};

            property.title = this.titleFromColumnName(columnName);

            const ordinalPosition = col['column_index'];
            if (ordinalPosition !== null && ordinalPosition !== undefined) {
                property['x-ogc-propertySeq'] = Number(ordinalPosition);
            }

            const comment = col['comment'];
            if (typeof comment === 'string' && comment.length > 0) {
                property.description = comment;
            }

            const enumValues = this.parseEnumValues(dataType);
            if (enumValues) {
                property.type = 'string';
                property.enum = enumValues;
            } else {
                Object.assign(property, this.mapDuckDBType(dataType));
            }

            if (dataType.trim().toUpperCase() === 'BLOB') {
                property.contentEncoding = 'base64';
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
                // Overrides whatever `mapDuckDBType` derived from the raw
                // DuckDB type name (e.g. `object` for `GEOMETRY`) with the
                // Part 5 geometry-subtype format QGIS uses to determine the
                // layer's geometry type without sampling features.
                property.format = geometryFormat;
            } else if (idColumn && columnName === idColumn) {
                property['x-ogc-role'] = 'id';
                // Same predicate `createFeature` uses to decide whether the
                // database will assign this column's value on INSERT (see
                // `idColumnWithDefault`) — a field the server silently
                // discards a client-supplied value for must be advertised
                // `readOnly`, and the two must never drift apart.
                if (columnName === assignedIdColumn) {
                    property.readOnly = true;
                }
            }

            properties[columnName] = property;

            // `duckdb_columns().is_nullable` is a real boolean (unlike
            // `information_schema.columns`, which renders 'YES'/'NO' strings).
            // A server-assigned id column (see above) is deliberately
            // excluded even though it is NOT NULL in the database.
            if (col['is_nullable'] === false && columnName !== assignedIdColumn) {
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
     * The Part 5 geometry `format` for the discovered geometry column:
     * `geometry-<type>` (e.g. `geometry-point`) when every non-null value in
     * the column shares exactly one `ST_GeometryType`, or `geometry-any` —
     * matching `InMemoryProvider`'s existing fallback — when the column is
     * empty, all-null, mixes more than one geometry type, or reports a type
     * this method doesn't recognise.
     *
     * Costs one `SELECT DISTINCT ST_GeometryType(...) FROM ... WHERE ... IS
     * NOT NULL` scan of the table per `getSchema` call — a full scan, not an
     * indexed lookup, so it scales with table size. That's acceptable for
     * `/schema`, which is not a hot path, but this must never be called from
     * a per-feature code path (`getFeatures`/`getFeature`).
     */
    private async geometryFormat(db: DuckDBConnection, tableName: string, geometryColumn: string): Promise<string> {
        const quotedCol = this.quote(geometryColumn);
        const reader = await db.runAndReadAll(`
            SELECT DISTINCT ST_GeometryType(${quotedCol}) AS geom_type
            FROM ${this.quote(tableName)}
            WHERE ${quotedCol} IS NOT NULL
            `);
        const rows = reader.getRowObjectsJS();
        if (rows.length !== 1) {
            return 'geometry-any';
        }

        const geomType = String(rows[0]!['geom_type']).toUpperCase();
        const knownTypes = new Set([
            'POINT',
            'LINESTRING',
            'POLYGON',
            'MULTIPOINT',
            'MULTILINESTRING',
            'MULTIPOLYGON',
            'GEOMETRYCOLLECTION',
        ]);
        return knownTypes.has(geomType) ? `geometry-${geomType.toLowerCase()}` : 'geometry-any';
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

    /**
     * Map a DuckDB `data_type` string to a JSON Schema `{ type, format }`
     * pair. Ordered deliberately, most-specific first, and matched by exact
     * string equality rather than substring for every type that has a fixed,
     * known rendering (`TIMESTAMP WITH TIME ZONE`, `TIMESTAMP`, `DATE`,
     * `TIME`, `UUID`, `BLOB`):
     *
     * `TIMESTAMP WITH TIME ZONE` *contains* the substring `TIME`, and even
     * plain `TIMESTAMP` starts with `"TIME"` + `"STAMP"` — so a naive
     * `includes('TIME')`/`startsWith('TIME')` check, if it ran before (or
     * instead of) an exact `TIMESTAMP` check, would misclassify every
     * timestamp column as a bare time-of-day. Checking the two `TIMESTAMP`
     * variants first and returning immediately closes that off: by the time
     * a `TIME` comparison is reached below, every string starting with
     * `"TIME"` other than the literal 4-character value `"TIME"` itself has
     * already matched and returned.
     *
     * The substring checks below (`GEOMETRY`/`POINT`/`POLYGON`/`LINESTRING`,
     * then `INT`) are the pre-existing ones, kept for every DuckDB type this
     * function doesn't otherwise recognise by exact name — including the
     * same `POINT`/`INT` collision this method already guarded against
     * (`'POINT'.includes('INT')` is true, so the spatial check must run
     * first).
     */
    private mapDuckDBType(duckdbType: string): CollectionSchemaProperty {
        const type = duckdbType.trim().toUpperCase();

        if (type === 'TIMESTAMP WITH TIME ZONE' || type === 'TIMESTAMPTZ') {
            return { type: 'string', format: 'date-time' };
        }
        if (type === 'TIMESTAMP') {
            return { type: 'string', format: 'date-time' };
        }
        if (type === 'DATE') {
            return { type: 'string', format: 'date' };
        }
        if (type === 'TIME') {
            return { type: 'string', format: 'time' };
        }
        if (type === 'UUID') {
            return { type: 'string', format: 'uuid' };
        }
        if (type === 'BLOB') {
            // `contentEncoding: 'base64'` is added by the caller, which also
            // knows the column is the one BLOB gets special-cased for.
            return { type: 'string' };
        }

        if (
            type.includes('GEOMETRY') ||
            type.includes('POINT') ||
            type.includes('POLYGON') ||
            type.includes('LINESTRING')
        ) {
            return { type: 'object' };
        }
        if (type.includes('INT')) return { type: 'integer' };
        if (type.includes('DOUBLE') || type.includes('FLOAT') || type.includes('DECIMAL')) return { type: 'number' };
        if (type.includes('BOOL')) return { type: 'boolean' };
        return { type: 'string' };
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
        const { timeColumns, dateColumns } = await this.temporalColumnKinds(db, tableName);

        // Built once and handed to both this query and `getFeatureCount`, so
        // the features returned and the total reported (`numberMatched`, which
        // drives `next`/`prev` pagination) can never apply different filters.
        const transform = await this.geometryTransform(req, tableName);
        const predicate = await this.buildPredicate(db, tableName, geometryColumn, params, transform);

        let query = `SELECT *, `;

        if (geometryColumn) {
            query += `ST_AsGeoJSON(${this.toApiCrs(this.quote(geometryColumn), transform)}) as __geometry_json `;
        }

        query += `FROM ${this.quote(tableName)} `;
        query += `${predicate.where} LIMIT ${limit} OFFSET ${offset}`;

        let rows;
        try {
            rows = await db.runAndReadAll(query, predicate.params);
        } catch (err) {
            throw this.translateFilterQueryError(err, predicate.filter);
        }

        const features: Feature[] = rows
            .getRowObjectsJS()
            .map((row) => this.rowToFeature(row, geometryColumn, timeColumns, dateColumns));

        return {
            type: 'FeatureCollection',
            features,
            numberMatched: await this.getFeatureCount(db, tableName, predicate),
            numberReturned: features.length,
        };
    }

    /**
     * Backs `numberMatched`. Takes the *same* `Predicate` `getFeatures` just
     * built and queried with — not a re-derivation from `params` — so this
     * can never drift out of sync with what the features query actually
     * matched. `tableName` is a physical table name (as produced by
     * `physicalTableName`).
     */
    private async getFeatureCount(
        db: DuckDBConnection,
        tableName: string,
        predicate: Predicate
    ): Promise<number> {
        const query = `SELECT COUNT(*) as count FROM ${this.quote(tableName)} ${predicate.where}`;
        let reader;
        try {
            reader = await db.runAndReadAll(query, predicate.params);
        } catch (err) {
            throw this.translateFilterQueryError(err, predicate.filter);
        }
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
        const { timeColumns, dateColumns } = await this.temporalColumnKinds(db, tableName);
        const transform = await this.geometryTransform(req, tableName);

        let query = `SELECT *, `;

        if (geometryColumn) {
            query += `ST_AsGeoJSON(${this.toApiCrs(this.quote(geometryColumn), transform)}) as __geometry_json `;
        }

        const idCols = await this.idColumns(db, tableName);
        query += `FROM ${this.quote(tableName)} WHERE ${this.idClause(idCols)}`;

        const reader = await db.runAndReadAll(query, idCols.map(() => featureId));
        const row = reader.getRowObjectsJS()[0];

        if (!row) {
            return null;
        }

        return this.rowToFeature(row, geometryColumn, timeColumns, dateColumns);
    }

    async getQueryables(req: DuckDBRequest, collectionId: string): Promise<Queryable> {
        const schema = await this.getSchema(req, collectionId);

        return {
            type: 'object',
            title: `Queryables for ${collectionId}`,
            properties: (schema.properties ?? {}) as Record<string, any>,
            $id: `/collections/${collectionId}/queryables`,
            $schema: 'https://json-schema.org/draft/2019-09/schema',
        };
    }

    async createFeature(req: DuckDBRequest, collectionId: string, feature: Feature): Promise<Feature | null> {
        const db = this.conn(req);
        const tableName = this.physicalTableName(req, collectionId);

        // Resolved once and reused both to strip a same-named `properties`
        // artifact (see `stripDiscoveredGeometryProperty`) and, below, to
        // know which column a top-level geometry should be written into.
        const geometryColumnName = await this.geometryColumn(db, tableName);
        let properties = this.stripDiscoveredGeometryProperty(feature.properties ?? {}, geometryColumnName);

        // OGC API - Features Part 4 has the server assign the resource id on
        // create. That's only actually possible when the identifier column
        // has a database default to fall back on (see `idColumnWithDefault`)
        // — a client-supplied value beats a plain column `DEFAULT` in an
        // INSERT, so the value has to be dropped from the column list
        // entirely, not merely left to a default that would never fire.
        // Without this, a QGIS client that picks its own id from a stale
        // view of the layer (and collides with an existing row) can never
        // successfully add a feature — the 409 the server correctly returns
        // is not something the client can recover from on its own. A table
        // whose identifier column has no default keeps today's behaviour
        // exactly: the client's value is honoured, and a collision still
        // surfaces as a 409 (see `translateWriteError`).
        const idCols = await this.idColumns(db, tableName);
        const assignedIdColumn = await this.idColumnWithDefault(db, tableName, idCols);
        if (assignedIdColumn && assignedIdColumn in properties) {
            const { [assignedIdColumn]: _discardedClientId, ...rest } = properties;
            properties = rest;
        }

        const columns = Object.keys(properties);
        const values = Object.values(properties) as DuckDBValue[];
        const placeholders = columns.map(() => '?');

        if (feature.geometry) {
            // Reuse the same column the read paths would discover, instead of
            // assuming it's literally named 'geometry' — GDAL/shapefile imports
            // commonly call it 'geom' or 'wkb_geometry'. Fall back to 'geometry'
            // only if the table doesn't have a recognizable spatial column yet.
            const geometryColumn = geometryColumnName ?? 'geometry';
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
            throw await this.translateWriteError(err, properties, db, tableName);
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

        // See createFeature: resolved once, reused to strip a same-named
        // `properties` artifact and to target the real geometry column below.
        const geometryColumnName = await this.geometryColumn(db, tableName);
        const properties = this.stripDiscoveredGeometryProperty(feature.properties ?? {}, geometryColumnName);

        const columns = Object.keys(properties);
        const values = Object.values(properties) as DuckDBValue[];
        const setParts = columns.map((col) => `${this.quote(col)} = ?`);

        if (feature.geometry) {
            // Same handling as createFeature: target the geometry column the
            // table actually has, not a hardcoded name, so a submitted
            // geometry is never silently dropped from a PUT.
            const geometryColumn = geometryColumnName ?? 'geometry';
            const transform = await this.geometryTransform(req, tableName);
            setParts.push(
                `${this.quote(geometryColumn)} = ${this.toStorageCrs('ST_GeomFromGeoJSON(?)', transform)}`
            );
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
            throw await this.translateWriteError(err, properties, db, tableName);
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

        // `updateFeature` (PATCH) never writes a top-level `feature.geometry`
        // to the geometry column at all today — only `properties` are ever
        // applied. That makes stripping the same-named `properties` entry
        // even more important here than for create/replace: without it, a
        // QGIS-shaped PATCH body carrying `"geometry": null` in `properties`
        // (alongside a top-level geometry this method doesn't otherwise
        // touch) would silently null out the stored geometry instead of
        // leaving it alone.
        const geometryColumnName = await this.geometryColumn(db, tableName);
        const updates = this.stripDiscoveredGeometryProperty(params.feature.properties ?? {}, geometryColumnName);
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
            throw await this.translateWriteError(err, updates, db, tableName);
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
            throw await this.translateWriteError(err, {}, db, tableName);
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
     *
     * `db`/`tableName` are only needed for the `Conversion Error` branch,
     * to look up whether the offending column is an `ENUM` (see
     * `enumValuesForColumn`) so its permitted values can be listed in the
     * message. Every call site already has both in scope, so they're taken
     * unconditionally rather than threading an optional pair through.
     */
    protected async translateWriteError(
        err: unknown,
        properties: Record<string, unknown>,
        db: DuckDBConnection,
        tableName: string
    ): Promise<unknown> {
        if (!(err instanceof Error)) {
            return err;
        }
        const message = err.message;

        const conversionMatch = /^Conversion Error: Could not convert string '((?:[^']|'')*)' to \w+/.exec(message);
        if (conversionMatch) {
            const rawValue = conversionMatch[1]!.replace(/''/g, "'");
            const property = this.findPropertyByValue(properties, rawValue);
            // DuckDB's own message can't tell an ENUM rejection from any
            // other conversion failure — both render as `Could not convert
            // string '<value>' to <physical-storage-type>` (e.g. `UINT8` for
            // a small ENUM, `INT32` for an INTEGER; see the class docstring
            // above `parseEnumValues`). Only a schema lookup on the
            // identified column tells us which case this is.
            const enumValues = property ? await this.enumValuesForColumn(db, tableName, property) : undefined;
            return new FeatureValidationError(
                property
                    ? this.invalidPropertyValueMessage(property, enumValues)
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

    /**
     * The permitted values for `columnName` if — and only if — it is an
     * `ENUM` column, for use in a conversion-error message (see
     * `translateWriteError`). Reads `data_type` for exactly that one column
     * from `duckdb_columns()` and hands it to `parseEnumValues`, the same
     * parser `getSchema` uses to build the `enum` array — so the two can
     * never disagree about what a given `ENUM(...)` rendering means.
     * Returns `undefined` for a non-ENUM column, and also for a column that
     * turns out not to exist (defensive: `columnName` came from
     * `findPropertyByValue` matching the client's request body, not from a
     * catalog lookup, so it is not guaranteed to name a real column).
     */
    private async enumValuesForColumn(
        db: DuckDBConnection,
        tableName: string,
        columnName: string
    ): Promise<string[] | undefined> {
        const reader = await db.runAndReadAll(`
            SELECT data_type
            FROM duckdb_columns()
            WHERE database_name = current_database() AND schema_name = current_schema()
              AND table_name = ? AND column_name = ?
            `, [tableName, columnName]);
        const row = reader.getRowObjectsJS()[0];
        if (!row) {
            return undefined;
        }
        return this.parseEnumValues(String(row['data_type']));
    }

    /**
     * The client-facing 400 message for a value that failed to convert into
     * its column's type. Lists the permitted values only when `enumValues`
     * is a non-empty array (i.e. the column is a real, populated `ENUM`) —
     * every other conversion failure (a non-numeric string into an
     * `INTEGER`, a bad date literal, ...) has no finite values list to offer
     * and keeps the pre-existing generic wording.
     *
     * Capped at `MAX_ENUM_VALUES_IN_MESSAGE` members: an ENUM with a
     * realistic handful to a couple dozen values (the common case — status
     * codes, categories, kinds) renders as one readable line, while an ENUM
     * with hundreds of members (unusual, but not impossible) would otherwise
     * produce an unusable wall of text and an effectively unbounded response
     * body. Truncation is called out explicitly (`, and N more`) rather than
     * silently dropped, so the message never implies a shorter list than the
     * column actually has.
     */
    private invalidPropertyValueMessage(property: string, enumValues: string[] | undefined): string {
        if (!enumValues || enumValues.length === 0) {
            return `Property "${property}" has a value that is not valid for its column.`;
        }
        const shown = enumValues.slice(0, DuckDBProvider.MAX_ENUM_VALUES_IN_MESSAGE);
        const remaining = enumValues.length - shown.length;
        const suffix = remaining > 0 ? `, and ${remaining} more` : '';
        return `Property "${property}" must be one of: ${shown.join(', ')}${suffix}.`;
    }

    addCollection(_collection: Collection): void {
        throw new Error('addCollection not supported by DuckDBProvider — create the table instead');
    }

    addFeature(_collectionId: string, _feature: Feature): void {
        // This would require creating the table structure dynamically
        throw new Error('addFeature not implemented for DuckDB provider');
    }
}
