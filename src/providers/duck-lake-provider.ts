// biome-ignore assist/source/organizeImports: matches the ordering used by duck-db-provider.ts
import { randomUUID } from 'node:crypto';
import type { DuckDBConnection, DuckDBValue } from '@duckdb/node-api';
import type { Collection, Feature, ProviderRequest } from '@/types';
import { OGCAPIConformanceClass, type OGCAPIConformanceItem } from '@/types/ogc-confirmance';
import {
    DuckDBProvider,
    type DuckDBLocals,
    type GeometryTransform,
} from '@/providers/duck-db-provider';
import { FeatureValidationError } from '@/errors';
import { crsFromGeometryTypeName, normalizeCrs } from '@/providers/geometry-crs';

/**
 * The three identifiers that scope a request to one project's layers.
 * Middleware is responsible for resolving these (from the URL path, from
 * token claims, or however the application authenticates) and putting them
 * on `res.locals.tenant` before the OGC router runs.
 */
export interface DuckLakeTenant {
    company: string;
    user: string;
    project: string;
}

/**
 * Locals `DuckLakeProvider` needs beyond the base `DuckDBLocals`. `db` must
 * be a connection whose *default catalog is the attached lake* — i.e.
 * middleware has run `USE <lakeAlias>.main` on it (see `attachDuckLake`).
 * Every metadata lookup this provider inherits is scoped to
 * `current_database()`, so a connection still pointing at `memory` reports
 * an empty collection list rather than silently reading the wrong catalog.
 */
export interface DuckLakeLocals extends DuckDBLocals {
    tenant: DuckLakeTenant;
}

type DuckLakeRequest = ProviderRequest<Record<string, string>, DuckLakeLocals>;

/** Options for {@link attachDuckLake}. */
export interface AttachDuckLakeOptions {
    /** Postgres connection string for the DuckLake catalog. */
    catalogConnectionString: string;
    /** Object-store prefix holding the Parquet data, e.g. `s3://bucket/`. */
    dataPath: string;
    /** Catalog alias to ATTACH as, and to `USE`. Defaults to `lake`. */
    alias?: string;
    /**
     * Alias to attach the DuckLake *metadata* catalog under, read-only.
     * Defaults to `<alias>_metadata`; pass `null` to skip it.
     *
     * DuckLake's own bookkeeping tables are not reachable through the DuckLake
     * attachment, so reaching them needs a second, plain Postgres attachment.
     * `DuckLakeProvider` uses it to read collection extents from
     * `ducklake_table_column_stats` instead of scanning every table's Parquet.
     */
    metadataAlias?: string | null;
    /**
     * S3 credentials. DuckDB's own `PROVIDER credential_chain` was observed
     * to produce `InvalidToken` against S3 when the ambient credentials come
     * from an AWS SSO session, so callers pass an explicit, already-resolved
     * triple instead (e.g. from `aws configure export-credentials`, or the
     * AWS SDK's `fromNodeProviderChain()`). Omit for a lake on local disk.
     *
     * These are short-lived under SSO/STS. Re-run `attachDuckLake`'s secret
     * step (or call `refreshS3Secret`) before they expire; an expired secret
     * surfaces as an HTTP 400 `InvalidToken` on the first S3 read, not at
     * ATTACH time, because ATTACH only touches the Postgres catalog.
     */
    s3?: {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
        region?: string;
    };
}

/** A table's geometry column and its declared type, as one batched lookup returns them. */
interface GeometryColumnInfo {
    column: string;
    dataType: string;
}

/** A 2D bounding box, `[minx, miny, maxx, maxy]` — the shape GeoJSON's `BBox` allows. */
type Bbox2D = [number, number, number, number];

/** Quote a single-quoted SQL string literal. */
function literal(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Escape a value for use inside a `LIKE` pattern with `ESCAPE '\\'`. Tenant
 * components are alphanumeric, but the `_` separators in a composed prefix are
 * LIKE wildcards and must match literally — otherwise `a_b_c_` would also match
 * `axbxcx`, i.e. another tenant.
 */
function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Read a bounding box out of DuckLake's `extra_stats`, the documented place it
 * records geometry statistics:
 *
 * ```json
 * {"bbox": {"xmin": 0, "xmax": 5, "ymin": 0, "ymax": 5, ...}, "types": ["point"]}
 * ```
 *
 * Returns `[minx, miny, maxx, maxy]`, or `undefined` if the blob is missing,
 * malformed, or carries a non-finite bound — a bbox containing `NaN` would
 * otherwise reach a client as a valid-looking extent.
 */
export function bboxFromExtraStats(extraStats: string): Bbox2D | undefined {
    let parsed: { bbox?: Record<string, unknown> };
    try {
        parsed = JSON.parse(extraStats) as { bbox?: Record<string, unknown> };
    } catch {
        return undefined;
    }
    const bbox = parsed.bbox;
    if (!bbox) {
        return undefined;
    }
    const [minx, miny, maxx, maxy] = [
        bbox['xmin'],
        bbox['ymin'],
        bbox['xmax'],
        bbox['ymax'],
    ].map(Number);
    return [minx, miny, maxx, maxy].every((n) => Number.isFinite(n))
        ? [minx as number, miny as number, maxx as number, maxy as number]
        : undefined;
}

/**
 * Install/load the extensions a DuckLake connection needs, register S3
 * credentials, ATTACH the lake and make it the connection's default
 * catalog.
 *
 * `USE <alias>.main` is not cosmetic: the provider's inherited metadata
 * lookups are scoped to `current_database()`/`current_schema()`, which is
 * what stops a same-named table in another attached catalog from being
 * mistaken for a lake table.
 */
export async function attachDuckLake(
    conn: DuckDBConnection,
    options: AttachDuckLakeOptions
): Promise<void> {
    const alias = options.alias ?? 'lake';

    for (const extension of ['spatial', 'ducklake', 'postgres', 'httpfs']) {
        await conn.run(`INSTALL ${extension}; LOAD ${extension};`);
    }

    if (options.s3) {
        await refreshS3Secret(conn, options.s3);
    }

    await conn.run(
        `ATTACH IF NOT EXISTS 'ducklake:postgres:${options.catalogConnectionString.replace(/'/g, "''")}' AS ${alias} (DATA_PATH ${literal(options.dataPath)})`
    );

    // The same catalog again, as plain Postgres, so DuckLake's statistics tables
    // can be read. Read-only: nothing here should ever write to the catalog
    // behind DuckLake's back.
    const metadataAlias =
        options.metadataAlias === null ? null : (options.metadataAlias ?? `${alias}_metadata`);
    if (metadataAlias) {
        await conn.run(
            `ATTACH IF NOT EXISTS ${literal(options.catalogConnectionString)} AS ${metadataAlias} (TYPE postgres, READ_ONLY)`
        );
    }

    await conn.run(`USE ${alias}.main`);
}

/**
 * (Re)register the S3 secret on a connection. Split out from
 * `attachDuckLake` so a long-lived instance can refresh expiring SSO/STS
 * credentials without re-attaching the catalog.
 */
export async function refreshS3Secret(
    conn: DuckDBConnection,
    s3: NonNullable<AttachDuckLakeOptions['s3']>
): Promise<void> {
    const parts = [
        'TYPE s3',
        `KEY_ID ${literal(s3.accessKeyId)}`,
        `SECRET ${literal(s3.secretAccessKey)}`,
    ];
    if (s3.sessionToken) {
        parts.push(`SESSION_TOKEN ${literal(s3.sessionToken)}`);
    }
    if (s3.region) {
        parts.push(`REGION ${literal(s3.region)}`);
    }
    await conn.run(`CREATE OR REPLACE SECRET ducklake_s3 (${parts.join(', ')})`);
}

/**
 * Validate one component of a tenant triple. The rules are the same ones
 * `examples/prefixed-duckdb-provider.ts` documents, and they are a security
 * boundary rather than a style preference: `_` is the separator in
 * `<company>_<user>_<project>_<collectionId>`, so a component containing
 * `_` would let one tenant's triple be crafted to collide with another's
 * prefix, and prefix-matching could then resolve across tenants.
 */
function assertValidComponent(value: unknown, field: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9]+$/.test(value)) {
        throw new Error(
            `Invalid res.locals.tenant.${field}: ${JSON.stringify(value)} — must be a non-empty string of letters and digits only (no underscores, which separate the tenant triple from the collection id)`
        );
    }
}

/**
 * A `DuckDBProvider` for a DuckLake catalog, scoped to one
 * `{company}_{user}_{project}` tenant per request.
 *
 * Everything here exists because DuckLake is not plain DuckDB. The
 * differences that actually shape this class, all confirmed against a live
 * DuckLake v1.0 catalog:
 *
 * - **No `RETURNING`.** Not on INSERT, UPDATE or DELETE. Only
 *   `createFeature` in the base class depends on it, so only that method is
 *   overridden here.
 * - **No sequences, no `PRIMARY KEY`/`UNIQUE`, no `IDENTITY`, no generated
 *   columns.** A column *can* carry `DEFAULT uuid()`, which is how a table
 *   gets server-assigned ids — but because the database cannot report the
 *   value it generated (no `RETURNING`), this class generates the uuid
 *   itself and inserts it explicitly, so the new feature can be read back.
 * - **No uniqueness enforcement.** Nothing stops duplicate ids, so a
 *   client-supplied id is checked for collision in a separate read here
 *   rather than relying on a constraint violation.
 * - **The catalog loses the CRS, but the data files keep it.** A
 *   parameterized `GEOMETRY('EPSG:...')` column is accepted by DDL and then
 *   flattened to plain `GEOMETRY` in the catalog, so `ST_CRS` reads `NULL`
 *   through the lake table. The Parquet files DuckLake writes do record it,
 *   in the native Parquet GEOMETRY logical type, so the CRS is recovered
 *   from a file's schema instead — no annotation required. See
 *   `parquetGeometryCrs`, `rawStorageCrs`, and `geometryTransform`, which
 *   reprojects to and from CRS84 on every read and write once the CRS is
 *   known.
 */
export class DuckLakeProvider extends DuckDBProvider {
    /**
     * Whether the collection's native storage CRS is offered to clients
     * (`'native'`) or the API speaks only CRS84 (`'crs84'`, the default).
     *
     * This is not cosmetic, and the default is deliberate. In `'native'` mode a
     * client may work in the storage CRS — QGIS adopts it as the layer CRS and
     * requests both features and `bbox` in it, which this provider honours. But
     * OGC API - Features reports a collection's `extent` in CRS84 regardless
     * (Core requires it, and the extent carries `crs: CRS84` saying so), and
     * QGIS reads that extent as being in the CRS it asked for. A projected layer
     * then gets an extent of a few degrees interpreted as metres — a dot at the
     * origin — so every real feature looks out of bounds. QGIS reports "Layer
     * extent reported by the server is not correct" and sweeps a huge area
     * hunting for data.
     *
     * `'crs84'` avoids the whole inconsistency: coordinates and extent are both
     * CRS84, so nothing can disagree. Reprojection still happens — that is
     * independent of what is advertised — so projected data is served correctly
     * as lon/lat. Choose `'native'` only if your clients handle Part 2 extents
     * properly and you want to avoid the reprojection cost.
     */
    protected readonly crsMode: 'crs84' | 'native';

    /**
     * Only meaningful in `'native'` mode: `CollectionHandler` gates `crs`/
     * `storageCrs` on this flag, and `ItemsCURDHandler` gates whether the
     * `crs`/`bbox-crs`/`filter-crs` parameters are live. In `'crs84'` mode they
     * are honestly inert rather than accepted-and-ignored.
     */
    public override readonly enableCrs: boolean;

    /**
     * Explicit per-collection storage CRS, as an OGC CRS URI or `EPSG:<code>`,
     * keyed by collection id (the tenant-stripped name). Consulted before the
     * geometry column's comment, so an application that knows its projection
     * doesn't have to write comments into the lake to say so.
     */
    private readonly crsByCollection: Readonly<Record<string, string>>;

    /** Fallback storage CRS for collections not covered by `crsByCollection`. */
    private readonly defaultStorageCrs: string | undefined;

    /**
     * Catalog alias the lake is attached as — the same name middleware passes
     * to `USE <alias>.main` — needed by `ducklake_list_files`.
     */
    protected readonly catalogName: string | undefined;

    /**
     * Memo for `parquetGeometryCrs`, keyed by physical table name. `null` means
     * "probed, nothing found", so a miss costs one object-store round trip
     * rather than one per request.
     */
    private readonly parquetCrsCache = new Map<string, string | null>();

    /**
     * Memo for the column-comment CRS fallback, keyed by physical table name.
     * `null` means "looked, no CRS there". Same reasoning as
     * `parquetCrsCache`: this is a per-table catalog round trip, and it sits on
     * the path that runs before every item read.
     */
    private readonly commentCrsCache = new Map<string, string | null>();

    /**
     * Alias the DuckLake metadata catalog is attached under, used to read extent
     * statistics. `undefined` disables that lookup, and collections are then
     * served without an extent rather than paying for a scan.
     */
    protected readonly metadataCatalog: string | undefined;

    /**
     * Per-request memo of the tenant's collection list, keyed by the response —
     * the same pattern (and lifetime) as the base class's discovery memo, so a
     * single request never runs discovery twice and nothing outlives it.
     */
    private readonly collectionsMemo = new WeakMap<object, Promise<Collection[]>>();

    constructor(options: {
        name: string;
        /** Catalog alias the lake is ATTACHed as. Defaults to `lake`. */
        catalogName?: string;
        /**
         * Alias the metadata catalog is attached under, as set up by
         * `attachDuckLake`. Defaults to `<catalogName>_metadata`; pass `null` to
         * disable extent statistics.
         */
        metadataCatalog?: string | null;
        crsByCollection?: Record<string, string>;
        defaultStorageCrs?: string;
        /**
         * `'crs84'` (default) serves everything as CRS84 lon/lat. `'native'`
         * additionally advertises the storage CRS and honours `crs`/`bbox-crs`/
         * `filter-crs` — see `crsMode` for why that is not the default.
         */
        crsMode?: 'crs84' | 'native';
    }) {
        super({ name: options.name });
        this.crsMode = options.crsMode ?? 'crs84';
        this.enableCrs = this.crsMode === 'native';
        this.catalogName = options.catalogName ?? 'lake';
        this.metadataCatalog =
            options.metadataCatalog === null
                ? undefined
                : (options.metadataCatalog ?? `${this.catalogName}_metadata`);
        this.crsByCollection = { ...(options.crsByCollection ?? {}) };
        this.defaultStorageCrs = options.defaultStorageCrs;
    }

    /**
     * Adds the Part 4 (Create/Replace/Update/Delete) and Part 2 (CRS)
     * classes to what the base advertises. Part 4 matters beyond
     * bookkeeping: a client decides whether to offer editing from the
     * conformance list, so the base's Core-only list makes a fully
     * write-capable server look read-only.
     */
    override conformanceClasses(): OGCAPIConformanceItem[] {
        return [
            ...super.conformanceClasses(),
            // Advertised only when the storage CRS is genuinely offered —
            // claiming Part 2 while serving CRS84 only would invite exactly the
            // client behaviour `crsMode` exists to avoid.
            ...(this.crsMode === 'native' ? [OGCAPIConformanceClass.FEATURES_CRS] : []),
            OGCAPIConformanceClass.FEATURES_CREATE_REPLACE_DELETE,
            OGCAPIConformanceClass.FEATURES_UPDATE,
            OGCAPIConformanceClass.FEATURES_FEATURES,
        ];
    }

    /** `<company>_<user>_<project>_<collectionId>`. Inverse of `collectionIdForTable`. */
    protected override physicalTableName(req: DuckLakeRequest, collectionId: string): string {
        return `${this.tenantPrefix(req)}${collectionId}`;
    }

    /**
     * Strips this request's tenant prefix off a discovered table name, or
     * returns `null` to hide the table from this tenant.
     *
     * Note this only ever *composes* a prefix and compares, never parses a
     * table name into components — the lake's names can't be parsed
     * reliably. Layer names contain underscores of their own
     * (`..._backbone_feeder_cable`), and company-level tables such as
     * `<company>_billed_points` have no user/project segment at all, so
     * splitting on `_` would mis-attribute them. Those tables simply don't
     * match any project prefix and stay hidden.
     */
    protected override collectionIdForTable(req: DuckLakeRequest, tableName: string): string | null {
        const prefix = this.tenantPrefix(req);
        return tableName.startsWith(prefix) ? tableName.slice(prefix.length) : null;
    }

    /** `<company>_<user>_<project>_`, validated. */
    private tenantPrefix(req: DuckLakeRequest): string {
        const tenant = req.res?.locals?.tenant as Partial<DuckLakeTenant> | undefined;
        if (!tenant) {
            throw new Error(
                'DuckLakeProvider: no tenant found at res.locals.tenant — mount middleware that sets { company, user, project } before the OGC router'
            );
        }
        assertValidComponent(tenant.company, 'company');
        assertValidComponent(tenant.user, 'user');
        assertValidComponent(tenant.project, 'project');
        return `${tenant.company}_${tenant.user}_${tenant.project}_`;
    }

    /**
     * The CRS a collection's stored coordinates are in, as an OGC URI, or
     * `undefined` when nothing declares it.
     *
     * Resolution order: explicit `crsByCollection` config, then the geometry
     * column's comment, then `defaultStorageCrs`. The comment is the only
     * in-lake mechanism that works — DuckLake flattens
     * `GEOMETRY('EPSG:25832')` to plain `GEOMETRY` and discards
     * `ST_SetCRS`, so `ST_CRS(geometry)` reads back `null`. Declare it with:
     *
     * ```sql
     * COMMENT ON COLUMN lake.main.<table>.geometry IS 'EPSG:25832';
     * ```
     */
    protected async storageCrsFor(
        db: DuckDBConnection,
        collectionId: string,
        tableName: string
    ): Promise<string | undefined> {
        const raw = await this.rawStorageCrs(db, collectionId, tableName);
        return raw ? normalizeCrs(raw) : undefined;
    }

    /**
     * The storage CRS as written (`EPSG:25832`), before normalisation to an
     * OGC URI. `ST_Transform` needs this form — PROJ resolves `EPSG:25832`
     * but not the URI — while collection metadata needs the URI, so the two
     * are kept separate rather than round-tripped.
     */
    protected async rawStorageCrs(
        db: DuckDBConnection,
        collectionId: string,
        tableName: string,
        known?: { column: string; dataType?: string; dataFile?: string }
    ): Promise<string | undefined> {
        // Explicit config first, as the operator's escape hatch for data that is
        // mislabelled at the source.
        const configured = this.crsByCollection[collectionId];
        if (configured) {
            return configured;
        }

        // `known` lets a caller that has already batched these lookups pass them
        // in. That matters more than it looks: against a remote catalog every
        // metadata query is its own round trip, so re-deriving the column and its
        // type per table is what made collection listings take a minute.
        const geometryColumn = known?.column ?? (await this.geometryColumn(db, tableName, true));
        if (geometryColumn) {
            // The authoritative source, and free: the column's own type
            // (`GEOMETRY('EPSG:25832')`) — the same answer `ST_CRS(geom)` gives,
            // without reading a row. Checked before the comment because a
            // declared type is real type information, whereas a comment is an
            // annotation that can go stale.
            const declared =
                known?.dataType !== undefined
                    ? crsFromGeometryTypeName(known.dataType)
                    : await this.declaredGeometryCrs(db, tableName, geometryColumn);
            if (declared) {
                return declared;
            }

            // The real source of truth for a DuckLake table. DuckLake's catalog
            // erases the column's type parameter, but the Parquet files it
            // writes record the CRS in the native GEOMETRY logical type as
            // PROJJSON — so `ST_CRS` reads NULL through the lake table and the
            // correct value through the file. Ranked above the comment because
            // this is what the data itself says.
            const fromParquet = await this.parquetGeometryCrs(
                db,
                tableName,
                geometryColumn,
                known?.dataFile
            );
            if (fromParquet) {
                return fromParquet;
            }

            // Fallback for DuckLake specifically. DuckLake's catalog stores the
            // column type as a bare `geometry`, so a column created as
            // `GEOMETRY('EPSG:25832')` comes back plain and `ST_CRS` reads
            // `NULL` — the type parameter never survives the round trip. A
            // column *comment* does persist (as a DuckLake column tag), so it
            // is the only in-lake place left to record a projection:
            //
            //   COMMENT ON COLUMN lake.main.<table>.geometry IS 'EPSG:25832';
            if (this.commentCrsCache.has(tableName)) {
                const remembered = this.commentCrsCache.get(tableName);
                return remembered ?? this.defaultStorageCrs;
            }
            const reader = await db.runAndReadAll(
                `SELECT comment FROM duckdb_columns()
                 WHERE database_name = current_database() AND schema_name = current_schema()
                   AND table_name = ? AND column_name = ?`,
                [tableName, geometryColumn]
            );
            const comment = reader.getRowObjectsJS()[0]?.['comment'];
            // Only a comment that actually parses as a CRS counts — a table
            // whose geometry column carries an unrelated human comment must not
            // be read as declaring a projection.
            const fromComment =
                comment != null && normalizeCrs(String(comment))
                    ? String(comment).trim()
                    : undefined;
            this.commentCrsCache.set(tableName, fromComment ?? null);
            if (fromComment) {
                return fromComment;
            }
        }

        return this.defaultStorageCrs;
    }

    /**
     * The Parquet data files backing a table, newest first.
     *
     * `ducklake_list_files` is a DuckLake table function, so this needs no
     * separate Postgres attachment to read the catalog. It returns nothing for
     * a table whose rows are still *inlined* in the catalog (DuckLake keeps
     * small writes there until `ducklake_flush_inlined_data`), which is a
     * normal state, not an error — callers fall through to the next CRS
     * source.
     */
    protected async dataFilePaths(db: DuckDBConnection, tableName: string): Promise<string[]> {
        try {
            const reader = await db.runAndReadAll(
                `SELECT data_file FROM ducklake_list_files(?, ?)`,
                [this.catalogName ?? 'lake', tableName]
            );
            return reader
                .getRowObjectsJS()
                .map((row) => String(row['data_file']))
                .filter((path) => path.length > 0);
        } catch {
            // Not a DuckLake-backed connection (a plain DuckDB table, say).
            // Not fatal: it just means this CRS source does not apply.
            return [];
        }
    }

    /**
     * The CRS recorded in the table's Parquet files, or `undefined`.
     *
     * Reads only the Parquet footer via `parquet_schema` — the file's
     * `GeometryType(crs={...})` logical type — rather than scanning rows. The
     * embedded document is PROJJSON, whose top-level `id` names the authority
     * and code (`EPSG:32632`); the nested `id`s inside it describe the datum,
     * ellipsoid and projection method, so only the outermost one identifies
     * the CRS as a whole.
     *
     * Memoised per table for the provider's lifetime, because `getCollection`
     * runs before every item read and this otherwise costs an object-store
     * round trip each time. A table's CRS does not change without rewriting
     * its data; restart the process (or pass `crsByCollection`) if it ever
     * does.
     */
    protected async parquetGeometryCrs(
        db: DuckDBConnection,
        tableName: string,
        geometryColumn: string,
        knownPath?: string
    ): Promise<string | undefined> {
        const cached = this.parquetCrsCache.get(tableName);
        if (cached !== undefined) {
            return cached ?? undefined;
        }

        const resolved = await this.readParquetGeometryCrs(
            db,
            tableName,
            geometryColumn,
            knownPath
        );
        // `null` records "looked, found nothing" so a miss is not re-probed.
        this.parquetCrsCache.set(tableName, resolved ?? null);
        return resolved;
    }

    private async readParquetGeometryCrs(
        db: DuckDBConnection,
        tableName: string,
        geometryColumn: string,
        knownPath?: string
    ): Promise<string | undefined> {
        const path = knownPath ?? (await this.dataFilePaths(db, tableName))[0];
        if (!path) {
            return undefined;
        }

        try {
            // `DESCRIBE` resolves the file's schema without reading a row, and
            // the geometry column comes back as `GEOMETRY('EPSG:32632')` — the
            // same value `ST_CRS()` would report for a row of it, at the cost of
            // a footer read rather than a data read.
            //
            // Going through the reader rather than parsing metadata by hand also
            // covers both encodings in the wild: DuckLake writes the native
            // Parquet GEOMETRY logical type, while DuckDB's own `COPY` writes
            // GeoParquet 1.0 (a `geo` key in the file's key/value metadata).
            // DuckDB understands both and surfaces them identically here.
            const reader = await db.runAndReadAll(
                `DESCRIBE SELECT ${this.quote(geometryColumn)} FROM read_parquet('${path.replace(/'/g, "''")}')`
            );
            const columnType = reader.getRowObjectsJS()[0]?.['column_type'];
            return columnType == null
                ? undefined
                : crsFromGeometryTypeName(String(columnType));
        } catch {
            // Unreadable file, expired credentials, a column absent from an
            // older file — none of which should turn a metadata read into a
            // failed request.
            return undefined;
        }
    }

    /**
     * Turns on `ST_Transform` on both the read and the write path whenever a
     * collection's storage CRS is known and is not already the CRS the API
     * speaks. Coordinates are then served as CRS84 lon/lat — what GeoJSON and
     * every default OGC client expect — and incoming geometries are projected
     * back to storage on write.
     *
     * When no CRS is declared, this returns `undefined` and coordinates pass
     * through untouched. That is the honest fallback: nothing can be
     * reprojected from an unknown CRS, and guessing would silently move data.
     */
    protected override async geometryTransform(
        req: DuckLakeRequest,
        tableName: string
    ): Promise<GeometryTransform | undefined> {
        return (await this.geometryTransforms(req, tableName)).output;
    }

    /**
     * A transform per CRS the client named, so `crs`, `bbox-crs` and
     * `filter-crs` are each honoured rather than merely accepted.
     *
     * This matters beyond conformance. Advertising the Part 2 conformance class
     * and a non-default `storageCrs` invites a client to work in that CRS —
     * QGIS, for one, will adopt it as the layer CRS and both request `crs=` and
     * send its `bbox` in it. Answering such a request with CRS84 coordinates
     * regardless puts every feature thousands of kilometres from where the
     * client plots it, and reading a projected `bbox` as if it were degrees
     * matches nothing at all. The layer loads and renders empty.
     *
     * Each parameter defaults to CRS84, which is what the spec requires when it
     * is absent.
     */
    protected override async geometryTransforms(
        req: DuckLakeRequest,
        tableName: string
    ): Promise<{
        output?: GeometryTransform;
        bbox?: GeometryTransform;
        filter?: GeometryTransform;
    }> {
        const collectionId = this.collectionIdForTable(req, tableName);
        if (collectionId === null) {
            return {};
        }
        const storage = await this.rawStorageCrs(this.conn(req), collectionId, tableName);
        if (!storage) {
            // Unknown storage CRS: nothing can be reprojected, in either
            // direction, so every parameter is inert rather than wrong.
            return {};
        }

        if (this.crsMode === 'crs84') {
            const toCrs84 = this.transformFor(storage, undefined);
            return { output: toCrs84, bbox: toCrs84, filter: toCrs84 };
        }

        const query = (req.query ?? {}) as Record<string, unknown>;
        return {
            output: this.transformFor(storage, query['crs']),
            bbox: this.transformFor(storage, query['bbox-crs']),
            filter: this.transformFor(storage, query['filter-crs']),
        };
    }

    /**
     * Build a storage -> requested transform, or `undefined` when no conversion
     * is needed. An unrecognised or unsupported value falls back to CRS84 rather
     * than being honoured blindly, so a client cannot make the server emit
     * coordinates in a CRS it never advertised.
     */
    protected transformFor(storage: string, requested: unknown): GeometryTransform | undefined {
        const storageUri = normalizeCrs(storage);
        const requestedUri =
            typeof requested === 'string' ? normalizeCrs(requested) : undefined;
        const target = requestedUri === storageUri ? storageUri : this.defaultCrs;

        // Target equals storage: the data is already in the requested CRS.
        if (target === storageUri) {
            return undefined;
        }
        return { storage, api: 'OGC:CRS84' };
    }

    /**
     * The CRS the geometry in a response is actually expressed in, as an OGC
     * URI — what the `Content-Crs` header has to report.
     */
    async responseCrs(req: DuckLakeRequest, collectionId: string): Promise<string> {
        const tableName = this.physicalTableName(req, collectionId);
        const storage = await this.rawStorageCrs(this.conn(req), collectionId, tableName);
        if (!storage) {
            return this.defaultCrs;
        }
        if (this.crsMode === 'crs84') {
            return this.defaultCrs;
        }
        // No transform means the geometry is emitted as stored.
        return this.transformFor(storage, (req.query as Record<string, unknown> | undefined)?.['crs'])
            ? this.defaultCrs
            : (normalizeCrs(storage) ?? this.defaultCrs);
    }

    /**
     * Collection discovery in a fixed, small number of round trips.
     *
     * The inherited implementation walks tables one at a time, and against a
     * DuckLake catalog every metadata lookup is a query to the remote catalog
     * database — measured at roughly half a second each, and *not* parallelisable
     * (a DuckDB connection serialises queries, so issuing them concurrently is
     * no faster). Listing 25 collections that way costs well over a minute,
     * which clients simply time out on.
     *
     * So the per-table work is replaced by three batched queries: one to list
     * tables, one for every geometry column, and one for every extent. The
     * extents come from DuckLake's own `ducklake_table_column_stats`, whose
     * `extra_stats` records a bounding box per geometry column — the alternative
     * being an `ST_Extent_Agg` scan of every table's Parquet, which is what made
     * this slow in the first place.
     */
    override async getCollections(req: DuckLakeRequest): Promise<Collection[]> {
        const cached = this.collectionsMemo.get(req.res as object);
        if (cached) {
            return cached;
        }
        const promise = this.discoverTenantCollections(req);
        if (req.res) {
            this.collectionsMemo.set(req.res as object, promise);
        }
        return promise;
    }

    private async discoverTenantCollections(req: DuckLakeRequest): Promise<Collection[]> {
        const db = this.conn(req);
        const prefix = this.tenantPrefix(req);

        // 1. This tenant's tables. `LIKE prefix%` is applied in SQL rather than
        //    filtering client-side, so a catalog with many tenants doesn't pay to
        //    ship every name over the wire. `collectionIdForTable` still decides
        //    what is visible, keeping the prefix rules in exactly one place.
        const tableRows = await db.runAndReadAll(
            `SELECT table_name FROM information_schema.tables
             WHERE table_catalog = current_database() AND table_schema = current_schema()
               AND table_name LIKE ${literal(`${escapeLike(prefix)}%`)} ESCAPE '\\'`
        );
        const tables: { tableName: string; collectionId: string }[] = [];
        for (const row of tableRows.getRowObjectsJS()) {
            const tableName = String(row['table_name']);
            const collectionId = this.collectionIdForTable(req, tableName);
            if (collectionId !== null) {
                tables.push({ tableName, collectionId });
            }
        }
        if (tables.length === 0) {
            return [];
        }

        // 2. Every geometry column, in one query.
        const geometryColumns = await this.geometryColumnsFor(db, prefix);

        // 3. Each table's storage CRS. Resolved before extents because the stored
        //    bounding boxes are in that CRS and have to be reprojected with it.
        //    Memoised per table across requests, so this is a one-off cost.
        const dataFiles = await this.dataFilePathsFor(
            db,
            tables.filter((t) => geometryColumns.has(t.tableName)).map((t) => t.tableName)
        );

        const crsByTable = new Map<string, string>();
        for (const { tableName, collectionId } of tables) {
            const info = geometryColumns.get(tableName);
            const raw = await this.rawStorageCrs(
                db,
                collectionId,
                tableName,
                info ? { ...info, dataFile: dataFiles?.get(tableName) } : undefined
            );
            if (raw) {
                crsByTable.set(tableName, raw);
            }
        }

        // 4. Every extent, in one query, from catalog statistics.
        const extents = await this.extentsFor(
            db,
            tables.map((t) => t.tableName),
            new Map([...geometryColumns].map(([t, info]) => [t, info.column])),
            crsByTable
        );

        return tables.map(({ tableName, collectionId }) => {
            const raw = crsByTable.get(tableName);
            return this.buildCollection(
                collectionId,
                extents.get(tableName),
                raw ? normalizeCrs(raw) : undefined
            );
        });
    }

    override async getCollection(
        req: DuckLakeRequest,
        collectionId: string
    ): Promise<Collection | null> {
        const db = this.conn(req);
        const tableName = this.physicalTableName(req, collectionId);

        const exists = await db.runAndReadAll(
            `SELECT 1 FROM information_schema.tables
             WHERE table_catalog = current_database() AND table_schema = current_schema()
               AND table_name = ?`,
            [tableName]
        );
        if (exists.getRowObjectsJS().length === 0) {
            return null;
        }

        // Deliberately does NOT fall back to the inherited extent scan. This runs
        // before every single item read, so an `ST_Extent_Agg` over the table
        // here would add a full Parquet scan to each feature fetched.
        const geometryColumn = await this.geometryColumn(db, tableName, true);
        const raw = await this.rawStorageCrs(
            db,
            collectionId,
            tableName,
            geometryColumn ? { column: geometryColumn } : undefined
        );
        const crsByTable = raw ? new Map([[tableName, raw]]) : new Map<string, string>();

        const extents = geometryColumn
            ? await this.extentsFor(
                  db,
                  [tableName],
                  new Map([[tableName, geometryColumn]]),
                  crsByTable
              )
            : new Map<string, Bbox2D>();

        return this.buildCollection(
            collectionId,
            extents.get(tableName),
            raw ? normalizeCrs(raw) : undefined
        );
    }

    /** Shared shape for both discovery paths. */
    private buildCollection(
        collectionId: string,
        bbox: Bbox2D | undefined,
        storageCrs: string | undefined
    ): Collection {
        const collection: Collection = {
            id: collectionId,
            title: collectionId,
            description: `Collection from table ${collectionId}`,
            itemType: 'feature',
            crs: [this.defaultCrs],
            ...(bbox ? { extent: { spatial: { bbox: [bbox], crs: this.defaultCrs } } } : {}),
        };
        // `CollectionHandler` would strip these anyway when `enableCrs` is off,
        // but the provider should not claim a CRS it is not offering in the first
        // place — a caller using the provider directly gets the same answer the
        // HTTP surface gives.
        if (!storageCrs || this.crsMode !== 'native') {
            return collection;
        }
        return {
            ...collection,
            storageCrs,
            crs: Array.from(new Set([this.defaultCrs, storageCrs])),
        };
    }

    /**
     * Every geometry column under a tenant prefix, with its declared type, in
     * one query. The type is carried along because it is also where a CRS is
     * declared (`GEOMETRY('EPSG:32632')`) — fetching it here keeps CRS
     * resolution from costing a query per table.
     */
    private async geometryColumnsFor(
        db: DuckDBConnection,
        prefix: string
    ): Promise<Map<string, GeometryColumnInfo>> {
        const reader = await db.runAndReadAll(
            `SELECT table_name, column_name, data_type FROM information_schema.columns
             WHERE table_catalog = current_database() AND table_schema = current_schema()
               AND table_name LIKE ${literal(`${escapeLike(prefix)}%`)} ESCAPE '\\'
               AND (data_type LIKE '%GEOMETRY%' OR data_type LIKE '%POINT%'
                    OR data_type LIKE '%POLYGON%' OR data_type LIKE '%LINESTRING%')`
        );
        const columns = new Map<string, GeometryColumnInfo>();
        for (const row of reader.getRowObjectsJS()) {
            const table = String(row['table_name']);
            // First geometry column wins, matching `geometryColumn`'s LIMIT 1.
            if (!columns.has(table)) {
                columns.set(table, {
                    column: String(row['column_name']),
                    dataType: String(row['data_type'] ?? ''),
                });
            }
        }
        return columns;
    }

    /**
     * Resolve and cache every table's storage CRS up front.
     *
     * Optional, but it moves a real cost off the first client request. CRS
     * resolution reads one Parquet footer per table, and while the result is
     * memoised for the provider's lifetime, the request that populates the cache
     * pays for all of it at once — enough, on a catalog of this size, for a GIS
     * client to give up and report the request as cancelled. Calling this at
     * startup means the first real request is already warm.
     *
     * Safe to call more than once, and safe to let fail: it only fills caches,
     * so a failure costs nothing but the speed-up.
     */
    async warmUp(db: DuckDBConnection): Promise<void> {
        const reader = await db.runAndReadAll(
            `SELECT table_name, column_name, data_type FROM information_schema.columns
             WHERE table_catalog = current_database() AND table_schema = current_schema()
               AND (data_type LIKE '%GEOMETRY%' OR data_type LIKE '%POINT%'
                    OR data_type LIKE '%POLYGON%' OR data_type LIKE '%LINESTRING%')`
        );
        const columns = new Map<string, string>();
        for (const row of reader.getRowObjectsJS()) {
            const table = String(row['table_name']);
            if (!columns.has(table)) {
                // A type that already declares its CRS needs no file probe.
                if (crsFromGeometryTypeName(String(row['data_type'] ?? ''))) {
                    continue;
                }
                columns.set(table, String(row['column_name']));
            }
        }

        const paths = await this.dataFilePathsFor(db, [...columns.keys()]);
        for (const [tableName, geometryColumn] of columns) {
            if (this.parquetCrsCache.has(tableName)) {
                continue;
            }
            await this.parquetGeometryCrs(db, tableName, geometryColumn, paths?.get(tableName));
        }
    }

    /**
     * One Parquet path per table, for many tables in a single query.
     *
     * `ducklake_list_files` takes one table at a time, so using it for a whole
     * tenant costs a catalog round trip per collection. The same information is
     * a join over the metadata catalog, which answers for every table at once.
     * Falls back to `undefined` (and hence to `dataFilePaths`) when the metadata
     * catalog isn't attached.
     *
     * `path_is_relative` is honoured per row: DuckLake stores relative paths by
     * default but a file registered from elsewhere carries an absolute one.
     */
    protected async dataFilePathsFor(
        db: DuckDBConnection,
        tableNames: string[]
    ): Promise<Map<string, string> | undefined> {
        if (!this.metadataCatalog || tableNames.length === 0) {
            return undefined;
        }
        try {
            const meta = this.quote(this.metadataCatalog);
            const reader = await db.runAndReadAll(
                `SELECT t.table_name,
                        CASE WHEN f.path_is_relative
                             THEN (SELECT value FROM ${meta}.ducklake_metadata WHERE key = 'data_path')
                                  || s.path || t.path || f.path
                             ELSE f.path
                        END AS full_path
                 FROM ${meta}.ducklake_data_file f
                 JOIN ${meta}.ducklake_table t
                   ON t.table_id = f.table_id AND t.end_snapshot IS NULL
                 JOIN ${meta}.ducklake_schema s
                   ON s.schema_id = t.schema_id AND s.end_snapshot IS NULL
                 WHERE f.end_snapshot IS NULL
                   AND t.table_name IN (${tableNames.map(() => '?').join(', ')})`,
                tableNames
            );
            const paths = new Map<string, string>();
            for (const row of reader.getRowObjectsJS()) {
                const table = String(row['table_name']);
                const path = row['full_path'];
                // One file is enough: the CRS is a property of the column, not
                // of an individual file.
                if (path != null && !paths.has(table)) {
                    paths.set(table, String(path));
                }
            }
            return paths;
        } catch {
            return undefined;
        }
    }

    /**
     * Extents for many tables at once, read from DuckLake's
     * `ducklake_table_column_stats.extra_stats` — a documented per-column
     * bounding box, so no table data is read.
     *
     * Needs the metadata catalog attached (see `attachDuckLake`), since it is not
     * reachable through the DuckLake attachment itself.
     *
     * Any table the statistics don't cover — one whose rows are still inlined in
     * the catalog with no Parquet file yet, or a plain DuckDB table, or a
     * deployment that disabled the metadata attachment — falls back to an
     * `ST_Extent_Agg` scan, so an extent is never silently dropped. That is the
     * expensive path this method exists to avoid, so it is only ever taken for
     * tables that genuinely have no statistics.
     *
     * Bounding boxes are stored in the table's own CRS, so they are reprojected
     * to the API's CRS here, in a single statement for all tables.
     */
    protected async extentsFor(
        db: DuckDBConnection,
        tableNames: string[],
        geometryColumns: Map<string, string>,
        crsByTable: Map<string, string>
    ): Promise<Map<string, Bbox2D>> {
        const result = new Map<string, Bbox2D>();
        const withGeometry = tableNames.filter((t) => geometryColumns.has(t));
        if (withGeometry.length === 0) {
            return result;
        }

        const raw = new Map<string, Bbox2D>();
        if (this.metadataCatalog) {
            for (const [table, bbox] of await this.statsExtents(db, withGeometry, geometryColumns)) {
                raw.set(table, bbox);
            }
        }

        for (const table of withGeometry) {
            if (!raw.has(table)) {
                const scanned = await this.scanExtent(db, table, geometryColumns.get(table) as string);
                if (scanned) {
                    raw.set(table, scanned);
                }
            }
        }

        if (raw.size === 0) {
            return result;
        }
        return await this.reprojectExtents(db, raw, crsByTable);
    }

    /** Bounding boxes from `ducklake_table_column_stats`, for many tables at once. */
    private async statsExtents(
        db: DuckDBConnection,
        withGeometry: string[],
        geometryColumns: Map<string, string>
    ): Promise<Map<string, Bbox2D>> {
        const result = new Map<string, Bbox2D>();
        if (!this.metadataCatalog) {
            return result;
        }
        let rows: Record<string, unknown>[];
        try {
            const meta = this.quote(this.metadataCatalog);
            const reader = await db.runAndReadAll(
                // Two-part naming on purpose: the metadata catalog is plain
                // Postgres, so its tables live in that database's default schema
                // (`public`), not in `main` — qualifying with `main` fails.
                // Letting the catalog resolve the schema also survives a lake
                // configured with a non-default metadata schema.
                `SELECT t.table_name, cs.extra_stats
                 FROM ${meta}.ducklake_table_column_stats cs
                 JOIN ${meta}.ducklake_table t
                   ON t.table_id = cs.table_id AND t.end_snapshot IS NULL
                 JOIN ${meta}.ducklake_column col
                   ON col.table_id = cs.table_id AND col.column_id = cs.column_id
                      AND col.end_snapshot IS NULL
                 WHERE t.table_name IN (${withGeometry.map(() => '?').join(', ')})
                   AND col.column_name IN (${withGeometry.map(() => '?').join(', ')})
                   AND cs.extra_stats IS NOT NULL`,
                [...withGeometry, ...withGeometry.map((t) => geometryColumns.get(t) as string)]
            );
            rows = reader.getRowObjectsJS();
        } catch {
            // Metadata catalog absent or unreadable: the caller falls back to a scan.
            return result;
        }

        // Parsed defensively, so a malformed stats blob for one table cannot
        // break the extents of the rest.
        for (const row of rows) {
            const bbox = bboxFromExtraStats(String(row['extra_stats'] ?? ''));
            if (bbox) {
                result.set(String(row['table_name']), bbox);
            }
        }
        return result;
    }

    /**
     * Last-resort extent: aggregate the geometry column itself. Reads table
     * data, which is why `statsExtents` is tried first.
     */
    private async scanExtent(
        db: DuckDBConnection,
        tableName: string,
        geometryColumn: string
    ): Promise<Bbox2D | undefined> {
        const column = this.quote(geometryColumn);
        try {
            const reader = await db.runAndReadAll(
                `SELECT ST_XMin(ST_Extent_Agg(${column})) minx, ST_YMin(ST_Extent_Agg(${column})) miny,
                        ST_XMax(ST_Extent_Agg(${column})) maxx, ST_YMax(ST_Extent_Agg(${column})) maxy
                 FROM ${this.quote(tableName)}`
            );
            const row = reader.getRowObjectsJS()[0];
            if (!row || row['minx'] == null) {
                return undefined;
            }
            const bounds = [row['minx'], row['miny'], row['maxx'], row['maxy']].map(Number);
            return bounds.every((n) => Number.isFinite(n)) ? (bounds as Bbox2D) : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Reproject many stored-CRS bounding boxes into the API's CRS in one
     * statement, rather than one round trip per table.
     */
    private async reprojectExtents(
        db: DuckDBConnection,
        raw: Map<string, Bbox2D>,
        crsByTable: Map<string, string>
    ): Promise<Map<string, Bbox2D>> {
        const result = new Map<string, Bbox2D>();
        const selects: string[] = [];

        for (const [tableName, bbox] of raw) {
            const storage = crsByTable.get(tableName);
            // No known CRS, or already the API's: report the stored box as-is,
            // consistent with the read path leaving such data untransformed.
            if (!storage || normalizeCrs(storage) === this.defaultCrs) {
                result.set(tableName, bbox);
                continue;
            }
            const envelope = `ST_MakeEnvelope(${bbox.map((n) => n.toString()).join(', ')})`;
            selects.push(
                `SELECT ${literal(tableName)} AS t, ` +
                    `ST_XMin(g) AS x1, ST_YMin(g) AS y1, ST_XMax(g) AS x2, ST_YMax(g) AS y2 ` +
                    `FROM (SELECT ${this.toApiCrs(envelope, { storage, api: 'OGC:CRS84' })} AS g)`
            );
        }

        if (selects.length === 0) {
            return result;
        }

        try {
            const reader = await db.runAndReadAll(selects.join(' UNION ALL '));
            for (const row of reader.getRowObjectsJS()) {
                result.set(String(row['t']), [
                    Number(row['x1']),
                    Number(row['y1']),
                    Number(row['x2']),
                    Number(row['y2']),
                ] as Bbox2D);
            }
        } catch {
            // A CRS PROJ cannot resolve: report the stored bbox unreprojected
            // rather than dropping the extent entirely.
            for (const [tableName, bbox] of raw) {
                if (!result.has(tableName)) {
                    result.set(tableName, bbox);
                }
            }
        }
        return result;
    }

    /**
     * `createFeature` without `RETURNING`, which DuckLake rejects outright.
     *
     * The base class relies on `INSERT ... RETURNING *` to learn the id of
     * the row it just wrote. Here the id is decided *before* the INSERT
     * instead, so the row can be read back by it afterwards:
     *
     * 1. A client-supplied id is honoured unless it already exists.
     * 2. On collision, or when the client supplied none, a `DEFAULT uuid()`
     *    column gets an application-generated uuid — matching the base's
     *    behaviour of assigning a fresh id rather than failing, which is
     *    what lets a QGIS client working from a stale view still add
     *    features. Because DuckLake has no `UNIQUE` constraint to violate,
     *    the collision is detected by an explicit read, not by catching a
     *    constraint error.
     * 3. On collision against a column with no default, a 409 — same as the
     *    base, since there is no id this server may invent.
     */
    override async createFeature(
        req: DuckLakeRequest,
        collectionId: string,
        feature: Feature
    ): Promise<Feature | null> {
        const db = this.conn(req);
        const tableName = this.physicalTableName(req, collectionId);

        const geometryColumnName = await this.geometryColumn(db, tableName);
        const properties = this.stripDiscoveredGeometryProperty(
            feature.properties ?? {},
            geometryColumnName
        );

        const idCols = await this.idColumns(db, tableName);
        const idColumn = idCols.length === 1 ? idCols[0] : undefined;
        const selfAssigning = await this.idColumnWithDefault(db, tableName, idCols);

        const writable: Record<string, unknown> = { ...properties };
        let featureId: string | undefined;

        if (idColumn) {
            const supplied = writable[idColumn];
            const suppliedId =
                supplied === undefined || supplied === null ? undefined : String(supplied);

            if (suppliedId !== undefined && !(await this.idExists(db, tableName, idCols, suppliedId))) {
                featureId = suppliedId;
            } else if (selfAssigning) {
                featureId = randomUUID();
            } else if (suppliedId !== undefined) {
                throw new FeatureValidationError(
                    `A feature with id '${suppliedId}' already exists in collection '${collectionId}'`,
                    { status: 409 }
                );
            } else {
                throw new FeatureValidationError(
                    `Collection '${collectionId}' requires an id: its '${idColumn}' column has no database default, and DuckLake supports neither sequences nor identity columns, so the server cannot assign one`,
                    { status: 400 }
                );
            }

            writable[idColumn] = featureId;
        }

        const columns = Object.keys(writable);
        const values = Object.values(writable) as DuckDBValue[];
        const placeholders = columns.map(() => '?');

        if (feature.geometry) {
            // Incoming GeoJSON is in the API's CRS, so it is projected back to
            // the collection's storage CRS on the way in — the inverse of what
            // the read path does.
            const transform = await this.geometryTransform(req, tableName);
            columns.push(geometryColumnName ?? 'geometry');
            placeholders.push(this.toStorageCrs('ST_GeomFromGeoJSON(?)', transform));
            values.push(JSON.stringify(feature.geometry));
        }

        const query = `
      INSERT INTO ${this.quote(tableName)} (${columns.map((c) => this.quote(c)).join(', ')})
      VALUES (${placeholders.join(', ')})
    `;

        try {
            await db.run(query, values);
        } catch (err) {
            throw await this.translateWriteError(err, writable, db, tableName);
        }

        // No RETURNING, so there is nothing to read the id out of: it had to
        // be known before the INSERT. A table with no identifier column at
        // all can be written to but not read back by id.
        return featureId === undefined
            ? null
            : await this.getFeature(req, collectionId, featureId);
    }

    /** Whether a row with this id already exists — DuckLake has no UNIQUE to lean on. */
    private async idExists(
        db: DuckDBConnection,
        tableName: string,
        idCols: string[],
        featureId: string
    ): Promise<boolean> {
        const reader = await db.runAndReadAll(
            `SELECT 1 FROM ${this.quote(tableName)} WHERE ${this.idClause(idCols)} LIMIT 1`,
            idCols.map(() => featureId)
        );
        return reader.getRowObjectsJS().length > 0;
    }
}

export default DuckLakeProvider;
