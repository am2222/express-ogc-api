# express-ogc-api

[![CI](https://github.com/am2222/express-ogc-api/actions/workflows/ci.yml/badge.svg)](https://github.com/am2222/express-ogc-api/actions/workflows/ci.yml)
[![Release](https://github.com/am2222/express-ogc-api/actions/workflows/release.yml/badge.svg)](https://github.com/am2222/express-ogc-api/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/express-ogc-api.svg)](https://www.npmjs.com/package/express-ogc-api)
[![npm downloads](https://img.shields.io/npm/dm/express-ogc-api.svg)](https://www.npmjs.com/package/express-ogc-api)
[![provenance](https://img.shields.io/badge/provenance-attested-brightgreen.svg)](https://docs.npmjs.com/generating-provenance-statements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)

Modern Express.js middleware for implementing [OGC API Features](https://ogcapi.ogc.org/features/) standards with full TypeScript support.

## Features

✨ **Modern** - Built with TypeScript 5.9 and ES Modules  
🚀 **Simple** - Easy to integrate with existing Express applications  
📦 **Extensible** - Provider-based architecture for custom data sources  
🌍 **Standards-compliant** - Implements OGC API Features and Common standards  
🔧 **Feature-rich** - Supports filtering, sorting, schemas, and CRUD operations  
💾 **In-Memory Provider** - Built-in provider for quick prototyping  
🦆 **DuckDB Provider** - Serve a DuckDB database directly, with CQL2 pushed down to SQL

## Installation

```bash
npm install express-ogc-api
```

## Quick Start

```typescript
import express from 'express';
import { OGCAPI, InMemoryProvider } from 'express-ogc-api';

const app = express();

// Create a data provider
const provider = new InMemoryProvider();

// Add a collection
provider.addCollection({
  id: 'cities',
  title: 'World Cities',
  description: 'Major cities worldwide',
  extent: {
    spatial: {
      bbox: [[-180, -90, 180, 90]],
      crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84'
    }
  }
});

// Add features
provider.addFeature('cities', {
  type: 'Feature',
  id: 'london',
  geometry: {
    type: 'Point',
    coordinates: [-0.1276, 51.5074]
  },
  properties: {
    name: 'London',
    population: 9002488
  }
});

// Create OGC API instance
const ogcAPI = new OGCAPI(provider, app, {
  title: 'My Geospatial API',
  description: 'OGC API Features implementation'
});

// Mount the router
app.use('/ogc', ogcAPI.getRouter());

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
  console.log('Landing page: http://localhost:3000/ogc');
});
```

## API Endpoints

The middleware automatically creates the following OGC API endpoints:

### Core Endpoints
- **`GET /`** - Landing page with API links
- **`GET /conformance`** - Conformance declaration
- **`GET /api`** - OpenAPI 3.0 definition of this API
- **`OPTIONS *`** - Allowed methods for any path, via the `Allow` header
- **`GET /collections`** - List of collections
- **`GET /collections/{collectionId}`** - Collection metadata

### Feature Endpoints
- **`GET /collections/{collectionId}/items`** - Get features from a collection
- **`GET /collections/{collectionId}/items/{featureId}`** - Get a specific feature

### Schema Endpoints (if provider supports schemas)
- **`GET /collections/{collectionId}/schema`** - JSON Schema for collection features

### Queryables (if provider supports filtering)
- **`GET /collections/{collectionId}/queryables`** - Queryable properties

### CRUD Operations (if provider supports transactions)
- **`POST /collections/{collectionId}/items`** - Create a new feature
- **`PUT /collections/{collectionId}/items/{featureId}`** - Replace a feature
- **`PATCH /collections/{collectionId}/items/{featureId}`** - Update a feature
- **`DELETE /collections/{collectionId}/items/{featureId}`** - Delete a feature

## Configuration

### OGCAPI Constructor

```typescript
new OGCAPI(provider: BaseProvider<any, any>, app: Application, options?: OGCFeaturesConfig)
```

**Parameters:**
- `provider` - An instance of `BaseProvider` or its subclass (e.g., `InMemoryProvider`)
- `app` - The Express application; used to detect an existing JSON body parser before mounting its own
- `options` - Optional configuration object

### Configuration Options

```typescript
interface OGCFeaturesConfig {
  basePath?: string;      // Optional public prefix override for generated links
  title?: string;         // API title for landing page
  description?: string;   // API description
}
```

Leave `basePath` unset unless you are behind a proxy that serves the API at a
different public path. Generated links otherwise follow the mount path, which is
what makes parametrized mounts work:

```typescript
app.use('/root/:dbid', ogcAPI.getRouter());
```

Every provider method then receives the request, so `req.params.dbid` is
available wherever you need it.

## Providers

### InMemoryProvider

Built-in provider for storing features in memory. Perfect for testing and prototyping.

```typescript
import { InMemoryProvider } from 'express-ogc-api';

const provider = new InMemoryProvider();

// Add a collection
provider.addCollection({
  id: 'cities',
  title: 'Cities',
  description: 'City features',
  extent: {
    spatial: {
      bbox: [[-180, -90, 180, 90]],
      crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84'
    }
  }
});

// Add features
provider.addFeature('cities', {
  type: 'Feature',
  id: 'nyc',
  geometry: {
    type: 'Point',
    coordinates: [-74.0060, 40.7128]
  },
  properties: {
    name: 'New York City',
    population: 8336817
  }
});
```

### DuckDBProvider

Serves an existing [DuckDB](https://duckdb.org/) database over OGC API - Features.
Unlike `InMemoryProvider`, you don't register collections or features: the
provider reads `information_schema` and **every table becomes a collection**,
named after itself. Schemas, CQL2 filtering and transactions are all enabled.

```typescript
import express from 'express';
import { DuckDBInstance } from '@duckdb/node-api';
import { OGCAPI, DuckDBProvider } from 'express-ogc-api';

// 1. Your application owns the connection — it opens it, loads the extensions
//    it needs, and closes it. The provider only borrows it, per request.
const instance = await DuckDBInstance.create('./cities.duckdb');
const db = await instance.connect();
await db.run('INSTALL spatial; LOAD spatial;');

const app = express();
const provider = new DuckDBProvider({ name: 'DuckDBProvider' });
const ogcAPI = new OGCAPI(provider, app, { title: 'Cities API' });

// 2. Hand the connection to the provider through res.locals.db. This is the
//    whole contract — plain Express middleware, no library hooks.
app.use('/ogc', (_req, res, next) => {
  res.locals.db = db;
  next();
});

app.use('/ogc', ogcAPI.getRouter());
app.listen(3000);
```

That's the entire integration. `GET /ogc/collections` now lists your tables.

#### The connection contract

The provider **never opens, owns, or closes a database**. It calls
`res.locals.db` on each request and borrows the connection for the duration of
the call. Consequences worth knowing:

- You control pooling, lifetime and shutdown.
- You choose which extensions are loaded — the provider assumes none.
- Different requests can be served by different connections (this is what makes
  per-tenant and per-database routing possible).
- If `res.locals.db` is missing, the request fails with an explicit
  `no connection found at res.locals.db` error rather than a `TypeError`.

#### What gets discovered automatically

| Discovered | How | Notes |
|---|---|---|
| Collections | every table in `current_schema()` | one collection per table |
| Geometry column | first column whose type matches `GEOMETRY` | name is irrelevant — `geom` and `wkb_geometry` both work, so GDAL/shapefile imports need no renaming |
| Feature id | an `id` or `fid` column | only these two names are recognised |
| Spatial extent | `ST_Extent` over the geometry column | widened type match, so specific types like `POINT` are found too |
| Property schema | column names and types | drives `/schema` and `/queryables` |

A table **must have an `id` or `fid` column** to be readable per-feature —
without one, `/items/{featureId}` raises
`Collection has no 'id' or 'fid' column to identify features by`.

#### Supported query parameters

`DuckDBProvider` pushes down only these, as SQL:

| Parameter | Status | How |
|---|---|---|
| `limit` | ✅ | `LIMIT`, capped at the provider's `maxLimit` |
| `offset` | ✅ | `OFFSET` |
| `bbox` | ✅ | `ST_Intersects` against `ST_MakeEnvelope` (needs the `spatial` extension) |
| `filter` / `filter-lang` | ⚠️ **ignored** | see below |
| `sortby` | ⚠️ **ignored** | — |
| `properties` | ⚠️ **ignored** | — |
| `skip-geometry` | ⚠️ **ignored** | — |
| `datetime` | ⚠️ **ignored** | — |

> [!WARNING]
> The ignored parameters are accepted and then **silently dropped** — the request
> returns `200` with *unfiltered, unsorted* data rather than an error. Because
> `DuckDBProvider` declares `enableFiltering`, `/queryables` is advertised and a
> `filter` is accepted, so a client has every reason to believe filtering
> happened. Do not rely on any of them for correctness or access control with
> this provider yet.

`Cql2ToSql` — the CQL2 → parameterised-SQL translator documented under
[CQL2 Filtering](#cql2-filtering) — is fully implemented and exported, but
`DuckDBProvider.getFeatures` does not currently call it. You can wire it in
yourself by overriding `getFeatures`, or use it directly for your own queries.
`InMemoryProvider`, by contrast, does implement `filter`, `sortby`, `properties`
and `skip-geometry`.

#### Mapping collection ids to table names

By default a collection id *is* a table name. Two `protected` hooks change that,
and they **must be exact inverses**:

```typescript
protected physicalTableName(req, collectionId): string        // id  -> table
protected collectionIdForTable(req, tableName): string | null  // table -> id (null hides it)
```

Every table reference and every `information_schema` lookup goes through
`physicalTableName`, and discovery maps each table through
`collectionIdForTable`, dropping every `null`. Breaking the symmetry is not a
cosmetic bug: discovery can advertise ids that reads then 404 on, or — the
security-relevant direction — a crafted collection id can resolve to a table the
request should not reach.

#### Multi-tenancy

Tenancy is deliberately **not** in the library. `examples/prefixed-duckdb-provider.ts`
is a copyable ~40-line subclass implementing the common approach: prefix physical
tables with a per-request key, so tenant `demo` sees `demo_points` as the
collection `points` and the prefix never appears in a URL.

```typescript
app.use('/root/:dbid', (req, res, next) => {
  if (!KNOWN_TENANTS.has(req.params.dbid)) {
    res.status(404).json({ code: '404', description: 'Unknown database' });
    return;
  }
  res.locals.db = db;
  res.locals.key = req.params.dbid;   // PrefixedDuckDBProvider reads this
  next();
});

app.use('/root/:dbid', ogcAPI.getRouter());
```

Because links follow the mount path, a parametrized mount needs no `basePath`.
Read that example before adapting it — it documents why the tenant key rejects
underscores (they separate key from collection id, so allowing them lets one
tenant's prefix collide with another's) and why a missing key throws instead of
quietly falling back to unprefixed tables.

#### Running the bundled examples

The `examples/` directory is not published to npm — clone the repo to run these.

| File | What it does |
|---|---|
| `example-memory-provider.ts` | `InMemoryProvider`, no database needed |
| `example-duckdb-provider.ts` | Builds an **in-memory** DuckDB seeded with cities, parks and roads for two tenants (`db1`, `db2`), then serves it |
| `build-demo-duckdb.ts` | Writes a **persistent** `examples/demo.duckdb` — points, lines and polygons around Prospect Park, Brooklyn |
| `serve-demo.ts` | Serves `demo.duckdb`, with a request log, for testing in a real GIS client |

```bash
npm install

# In-memory, multi-tenant demo on :3001 — try /root/db1 and /root/db2
npm run example

# Or the persistent file, for QGIS testing on :3005
npx tsx examples/build-demo-duckdb.ts
npx tsx examples/serve-demo.ts
```

To open it in **QGIS**: Layer → Add Layer → Add WFS / OGC API - Features Layer,
create a new connection pointing at the landing page the server prints
(`http://localhost:3005/root/demo`), then connect. The three demo layers overlap
in one view, which makes the geometry easy to sanity-check.

#### Notes and limitations

- **Load the `spatial` extension yourself** (`INSTALL spatial; LOAD spatial;`)
  before any request using `bbox` or a spatial CQL2 operator.
- `BIGINT`/`UBIGINT`/`HUGEINT` come back from DuckDB as JS `bigint`, which
  `JSON.stringify` cannot serialize. The provider converts them: to `number`
  within the safe-integer range, otherwise to a decimal string.
- Only `id` and `fid` are recognised as identity columns.
- `getCollections` is memoised per request in a `WeakMap` keyed by the response,
  so a single request never scans the catalog twice and nothing outlives the
  request. Single-collection reads skip discovery entirely.

### Custom Providers

Extend `BaseProvider` to create custom data sources. Provider methods that run
inside a request receive the Express request first, typed through
`ProviderRequest<TParams, TLocals>` — `TParams` describes `req.params` (for
example the tenant id from a parametrized mount), and `TLocals` describes
whatever your own middleware attaches to `req.res.locals`:

```typescript
import { BaseProvider, OGCAPIConformanceClass } from 'express-ogc-api';
import type { ProviderRequest, QueryParams } from 'express-ogc-api';

type MyParams = { dbid: string };
type MyLocals = { tenant: { id: string } };

class MyCustomProvider extends BaseProvider<MyParams, MyLocals> {
  constructor() {
    super({ name: 'MyCustomProvider' });
  }

  conformanceClasses() {
    return [
      OGCAPIConformanceClass.COMMON_CORE,
      OGCAPIConformanceClass.COMMON_LANDING_PAGE,
      OGCAPIConformanceClass.FEATURES_CORE,
    ];
  }

  async getCollections(req: ProviderRequest<MyParams, MyLocals>) {
    const { dbid } = req.params;          // from the mount path
    const { tenant } = req.res.locals;    // from your own middleware
    // ...
  }

  async getFeatures(
    req: ProviderRequest<MyParams, MyLocals>,
    collectionId: string,
    params: QueryParams
  ) {
    // ...
  }

  // Implement other abstract methods...
}
```

## Query Parameters

The following OGC API query parameters are parsed from the request and passed to
the provider as `QueryParams`. **Whether each one takes effect is up to the
provider** — `InMemoryProvider` implements all of them, while `DuckDBProvider`
currently honours only `limit`, `offset` and `bbox` (see
[Supported query parameters](#supported-query-parameters)):

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | number | Maximum number of features to return |
| `offset` | number | Starting position for pagination |
| `bbox` | string | Bounding box filter (minx,miny,maxx,maxy) |
| `datetime` | string | Temporal filter (ISO 8601) |
| `filter` | string | CQL2 filter expression |
| `filter-lang` | string | Filter language (e.g., 'cql2-text') |
| `sortby` | string | Sort by properties (+prop or -prop) |
| `properties` | string | Comma-separated list of properties to return |
| `skip-geometry` | boolean | Skip geometry in response |

## CQL2 Filtering

`Cql2ToSql` translates a CQL2 filter (text or JSON) into **parameterised** SQL for
DuckDB.

Both the parse and the SQL generation come from
[`cql2-rs`](https://github.com/developmentseed/cql2-rs) via WebAssembly — the same
engine behind the [official playground](https://developmentseed.org/cql2-rs/latest/playground/),
using its `to_ducksql()` translation. This package adds the three things that
translation does not do on its own: bound parameters, identifier control, and a
short list of corrections for SQL DuckDB will not accept.

```ts
import { Cql2ToSql } from 'express-ogc-api';

const translator = new Cql2ToSql();

translator.toSql("casei(name) = casei('bob')");
// { sql: 'lower("name") = lower(?)', params: ['bob'] }
```

Pass the result straight to DuckDB:

```ts
const { sql, params } = translator.toSql(req.query.filter as string);
await db.runAndReadAll(`SELECT * FROM cities WHERE ${sql}`, params);
```

String values from the filter are always bound parameters, never concatenated
into SQL. Numeric literals are left inline, where they cannot carry injection.

### Restricting properties

Pass `allowedProperties` — normally a collection's queryables — so an unknown
property is rejected before it reaches the database:

```ts
const translator = new Cql2ToSql({ allowedProperties: ['name', 'pop', 'geom'] });

translator.toSql('secret = 1');
// throws Cql2Error { code: 'UNKNOWN_PROPERTY' }
```

`Cql2Error` carries a `code` of `PARSE_ERROR`, `UNSUPPORTED_OP` or
`UNKNOWN_PROPERTY`, all of which should map to HTTP 400.

### Supported operations

Whatever `cql2-rs` translates: the logical and comparison operators, `LIKE`,
`BETWEEN`, `IN`, `IS NULL`, arithmetic, `CASEI`/`ACCENTI`, the `S_*` spatial
predicates with `BBOX`, the `T_*` temporal relations, and the `A_*` array
operations. See the [playground](https://developmentseed.org/cql2-rs/latest/playground/)
to check any particular expression.

Any other operation is rejected with `Cql2Error { code: 'UNSUPPORTED_OP' }`, naming
it. Pass `additionalOps` to allow one through — useful for a database function
`cql2-rs` will translate but this package does not list.

### Corrections

Corrections are applied at three stages, and each is covered by a test that fails
if upstream stops needing it:

| Stage | Construct | Why |
|---|---|---|
| Before parsing | `'O''Brien'` literals | the upstream text parser silently truncates at an escaped quote |
| Before parsing | `note = 1` identifiers | the upstream text grammar reads this as `NOT (e = 1)` |
| On the AST | `A_EQUALS` → two-way `A_CONTAINS` | CQL2 defines it as set equality; upstream's `=` is order-sensitive |
| On the AST | `'..'` interval bounds → `-infinity` / `infinity` | `to_ducksql()` passes `'..'` into a timestamp cast, which DuckDB rejects |
| On the AST | unsupported operations | rejected as `UNSUPPORTED_OP` rather than failing later as a SQL error |
| On the SQL | `bbox(...)` → `ST_MakeEnvelope(...)` | `to_ducksql()` emits `bbox()`, which DuckDB does not define |

The AST corrections matter more than the count suggests: the filter is parsed to
CQL2-JSON, corrected against unambiguous structure, then handed **back** to
`cql2-rs` to translate. So `A_EQUALS` becomes `list_has_all` because upstream
generates it from the rewritten AST — not because we pattern-matched its SQL.

Only `bbox` remains a patch on generated text. The patch list can be extended or
replaced:

```ts
import { Cql2ToSql, duckdbPatches } from 'express-ogc-api';

const translator = new Cql2ToSql({
  patches: [
    ...duckdbPatches,
    { name: 'mine', reason: 'target a custom spatial index', apply: (sql) =>
        sql.replace(/\bst_intersects\(/gi, 'ST_Intersects_Extent(') },
  ],
});
```

`quoteIdentifier` overrides identifier quoting for a non-DuckDB target, though the
generated SQL is DuckDB-flavoured regardless.

### Notes and limitations

- The **application must load DuckDB's `spatial` extension** (`INSTALL spatial;
  LOAD spatial;`) before running a filter that uses spatial or `BBOX` operations.
- Bound parameters follow the order they appear in the **generated SQL**, which is
  not always the order the filter listed them — `to_ducksql()` reorders some
  operands (`T_AFTER(a, b)` becomes `b < a`).
- Property names that are not bare identifiers (containing a space, say) cannot be
  expressed in `cql2-text` — the upstream grammar rejects quoted identifiers. Use
  `cql2-json` for those.
- `filter-crs` is not applied; filter geometries are assumed to be in the
  collection's storage CRS.

## TypeScript Support

Full TypeScript support with comprehensive type definitions:

```typescript
import {
  OGCAPI,
  InMemoryProvider,
  DuckDBProvider,
  BaseProvider,
  Cql2ToSql,
  OGCAPIConformanceClass,
} from 'express-ogc-api';

import type {
  OGCFeaturesConfig,
  ProviderRequest,
  DuckDBLocals,
  Feature,
  FeatureCollection,
  Collection,
  Queryable,
  QueryParams,
  UpdateFeatureParams,
} from 'express-ogc-api';
```

`Feature` and `FeatureCollection` build on [`@types/geojson`](https://www.npmjs.com/package/@types/geojson),
so `geometry` is a proper discriminated union rather than `any` — narrowing on
`geometry.type` gives you typed `coordinates`:

```typescript
if (feature.geometry?.type === 'Point') {
  const [lon, lat] = feature.geometry.coordinates;  // typed [number, number]
}
```

`geometry` is `Geometry | null`, because RFC 7946 permits unlocated features and
that is also what `skip-geometry` returns. `Queryable` extends `JSONSchema7`.

## Conformance Classes

Both `InMemoryProvider` and `DuckDBProvider` declare the following OGC API
conformance classes, and `DuckDBProvider` adds the Features **schemas** class on
top (it sets `enableSchemas`):

- `http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/core`
- `http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/landing-page`
- `http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/json`
- `http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core`
- `http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson`

## Development

```bash
# Install dependencies
npm install

# Typecheck without emitting
npm run typecheck

# Build the project (tsc, then tsc-alias to rewrite @/* paths and add
# the .js extensions Node's ESM resolver requires)
npm run build

# Run tests once
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with UI
npm run test:ui

# Debug tests
npm run test:debug

# Run linter
npm run lint

# Format code
npm run format
```

## Requirements

- Node.js >= 20.0.0
- Express.js >= 4.18.0 or >= 5.0.0 (a peer dependency — install it yourself)

## Standards

This middleware implements:

- [OGC API - Common](https://ogcapi.ogc.org/common/)
- [OGC API - Features](https://ogcapi.ogc.org/features/)

Providing:
- Landing page with API links
- Conformance declaration
- Collection metadata
- Feature retrieval with filtering and pagination
- JSON Schema support
- CRUD operations (Create, Read, Update, Delete)

## Migrating

**Provider methods now take the Express request first.** `getCollections`,
`getCollection`, `getFeatures`, `getFeature`, `getSchema`, `getQueryables`,
`createFeature`, `replaceFeature`, `updateFeature` and `deleteFeature` all gained
a leading `req` parameter. `conformanceClasses`, `addCollection` and `addFeature`
are unchanged — they run outside a request. If a provider calls its own methods
internally, thread `req` through those calls too.

**`preProviderHook` / `postProviderHook` / `setupProviderHooks` are gone.** Use
Express directly:

```typescript
app.use((req, res, next) => {
  // was preProviderHook
  res.on('finish', () => {
    // was postProviderHook
  });
  next();
});
```

**`basePath` is now an override, not the mount path.** If you set it to the same
value you mount at, nothing changes and you can delete it. Do not set it when
mounting at a parametrized path — it cannot know the resolved param values.

## Releasing

Releases are automated, and the two GitHub Actions badges at the top of this file
track the two halves of it:

- **CI** — runs on every push and pull request: typecheck, tests on Node 20, 22
  and 24, a build, and an import of the built `dist/index.js` (a green typecheck
  does not prove the emitted package actually loads).
- **Release** — runs on pushes to `main`.
  [release-please](https://github.com/googleapis/release-please) reads
  [Conventional Commit](https://www.conventionalcommits.org/) messages and keeps a
  release pull request open with the pending version bump and changelog. Merging
  that PR tags the release and publishes to npm.

Publishing uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
over GitHub's OIDC — there is no npm token stored in this repository. npm verifies
the workflow identity and issues a short-lived credential, and every release
carries an automatically generated
[provenance attestation](https://docs.npmjs.com/generating-provenance-statements)
linking the published tarball to the exact commit and workflow run that built it.

So commit messages decide versions: `fix:` → patch, `feat:` → minor, and a
`feat!:` or `BREAKING CHANGE:` footer → major.

## License

MIT © Majid Hojati

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Related Projects

- [OGC API Standards](https://ogcapi.ogc.org/)
- [Express.js](https://expressjs.com/)

## Support

For issues and questions, please use the [GitHub issue tracker](https://github.com/am2222/express-ogc-api/issues).
