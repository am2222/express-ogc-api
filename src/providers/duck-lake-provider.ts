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

/** Quote a single-quoted SQL string literal. */
function literal(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
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
 * - **No CRS in the geometry type.** A parameterized `GEOMETRY('EPSG:...')`
 *   column is accepted by DDL and then flattened to plain `GEOMETRY`, and
 *   `ST_SetCRS` does not survive a write/read round trip. A column
 *   *comment* does persist (as a DuckLake column tag), so that is where
 *   this class reads a storage CRS from — and, once known, it reprojects
 *   to and from CRS84 on every read and write. See `rawStorageCrs` and
 *   `geometryTransform`.
 */
export class DuckLakeProvider extends DuckDBProvider {
    /**
     * Turned on so `crs`/`storageCrs` reach collection responses at all —
     * `CollectionHandler` gates both fields on this flag — and because this
     * class genuinely does transform coordinates rather than merely
     * advertising a CRS (see `geometryTransform`), which is what the flag is
     * documented to mean.
     */
    public override readonly enableCrs = true;

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

    constructor(options: {
        name: string;
        /** Catalog alias the lake is ATTACHed as. Defaults to `lake`. */
        catalogName?: string;
        crsByCollection?: Record<string, string>;
        defaultStorageCrs?: string;
    }) {
        super({ name: options.name });
        this.catalogName = options.catalogName ?? 'lake';
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
            OGCAPIConformanceClass.FEATURES_CRS,
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
        tableName: string
    ): Promise<string | undefined> {
        // Explicit config first, as the operator's escape hatch for data that is
        // mislabelled at the source.
        const configured = this.crsByCollection[collectionId];
        if (configured) {
            return configured;
        }

        const geometryColumn = await this.geometryColumn(db, tableName, true);
        if (geometryColumn) {
            // The authoritative source, and free: the column's own type
            // (`GEOMETRY('EPSG:25832')`) — the same answer `ST_CRS(geom)` gives,
            // without reading a row. Checked before the comment because a
            // declared type is real type information, whereas a comment is an
            // annotation that can go stale.
            const declared = await this.declaredGeometryCrs(db, tableName, geometryColumn);
            if (declared) {
                return declared;
            }

            // The real source of truth for a DuckLake table. DuckLake's catalog
            // erases the column's type parameter, but the Parquet files it
            // writes record the CRS in the native GEOMETRY logical type as
            // PROJJSON — so `ST_CRS` reads NULL through the lake table and the
            // correct value through the file. Ranked above the comment because
            // this is what the data itself says.
            const fromParquet = await this.parquetGeometryCrs(db, tableName, geometryColumn);
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
            if (comment != null && normalizeCrs(String(comment))) {
                return String(comment).trim();
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
        geometryColumn: string
    ): Promise<string | undefined> {
        const cached = this.parquetCrsCache.get(tableName);
        if (cached !== undefined) {
            return cached ?? undefined;
        }

        const resolved = await this.readParquetGeometryCrs(db, tableName, geometryColumn);
        // `null` records "looked, found nothing" so a miss is not re-probed.
        this.parquetCrsCache.set(tableName, resolved ?? null);
        return resolved;
    }

    private async readParquetGeometryCrs(
        db: DuckDBConnection,
        tableName: string,
        geometryColumn: string
    ): Promise<string | undefined> {
        const [path] = await this.dataFilePaths(db, tableName);
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
        const collectionId = this.collectionIdForTable(req, tableName);
        if (collectionId === null) {
            return undefined;
        }

        const storage = await this.rawStorageCrs(this.conn(req), collectionId, tableName);
        if (!storage) {
            return undefined;
        }

        // Already in the API's CRS: nothing to do, and wrapping it would cost a
        // PROJ round trip per row for an identity transform.
        if (normalizeCrs(storage) === this.defaultCrs) {
            return undefined;
        }

        return { storage, api: 'OGC:CRS84' };
    }

    /** Attach the resolved storage CRS to whatever the base built. */
    private async withCrs(
        db: DuckDBConnection,
        req: DuckLakeRequest,
        collection: Collection
    ): Promise<Collection> {
        const storageCrs = await this.storageCrsFor(
            db,
            collection.id,
            this.physicalTableName(req, collection.id)
        );
        if (!storageCrs) {
            return collection;
        }
        return {
            ...collection,
            storageCrs,
            // Both are listed because the coordinates are served as stored:
            // CRS84 is the protocol default a client assumes, and storageCrs
            // is what the numbers actually are.
            crs: Array.from(new Set([...(collection.crs ?? [this.defaultCrs]), storageCrs])),
        };
    }

    override async getCollections(req: DuckLakeRequest): Promise<Collection[]> {
        const collections = await super.getCollections(req);
        const db = this.conn(req);
        return Promise.all(collections.map((c) => this.withCrs(db, req, c)));
    }

    override async getCollection(
        req: DuckLakeRequest,
        collectionId: string
    ): Promise<Collection | null> {
        const collection = await super.getCollection(req, collectionId);
        return collection ? await this.withCrs(this.conn(req), req, collection) : null;
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
