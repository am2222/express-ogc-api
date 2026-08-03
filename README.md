# express-ogc-api

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

Modern Express.js middleware for implementing [OGC API Features](https://ogcapi.ogc.org/features/) standards with full TypeScript support.

## Features

✨ **Modern** - Built with TypeScript 5.9 and ES Modules  
🚀 **Simple** - Easy to integrate with existing Express applications  
📦 **Extensible** - Provider-based architecture for custom data sources  
🌍 **Standards-compliant** - Implements OGC API Features and Common standards  
🔧 **Feature-rich** - Supports filtering, sorting, schemas, and CRUD operations  
💾 **In-Memory Provider** - Built-in provider for quick prototyping

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
- **\`GET /\`** - Landing page with API links
- **\`GET /conformance\`** - Conformance declaration
- **\`GET /api\`** - OpenAPI 3.0 definition of this API
- **\`OPTIONS *\`** - Allowed methods for any path, via the \`Allow\` header
- **\`GET /collections\`** - List of collections
- **\`GET /collections/{collectionId}\`** - Collection metadata

### Feature Endpoints
- **\`GET /collections/{collectionId}/items\`** - Get features from a collection
- **\`GET /collections/{collectionId}/items/{featureId}\`** - Get a specific feature

### Schema Endpoints (if provider supports schemas)
- **\`GET /collections/{collectionId}/schema\`** - JSON Schema for collection features

### Queryables (if provider supports filtering)
- **\`GET /collections/{collectionId}/queryables\`** - Queryable properties

### CRUD Operations (if provider supports transactions)
- **\`POST /collections/{collectionId}/items\`** - Create a new feature
- **\`PUT /collections/{collectionId}/items/{featureId}\`** - Replace a feature
- **\`PATCH /collections/{collectionId}/items/{featureId}\`** - Update a feature
- **\`DELETE /collections/{collectionId}/items/{featureId}\`** - Delete a feature

## Configuration

### OGCAPI Constructor

```typescript
new OGCAPI(provider: BaseProvider<any, any>, app: Application, options?: OGCFeaturesConfig)
```

**Parameters:**
- \`provider\` - An instance of \`BaseProvider\` or its subclass (e.g., \`InMemoryProvider\`)
- \`app\` - The Express application; used to detect an existing JSON body parser before mounting its own
- \`options\` - Optional configuration object

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

### Custom Providers

Extend \`BaseProvider\` to create custom data sources. Provider methods that run
inside a request receive the Express request first, typed through
\`ProviderRequest<TParams, TLocals>\` — \`TParams\` describes \`req.params\` (for
example the tenant id from a parametrized mount), and \`TLocals\` describes
whatever your own middleware attaches to \`req.res.locals\`:

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

The following OGC API query parameters are supported (when provider enables them):

| Parameter | Type | Description |
|-----------|------|-------------|
| \`limit\` | number | Maximum number of features to return |
| \`offset\` | number | Starting position for pagination |
| \`bbox\` | string | Bounding box filter (minx,miny,maxx,maxy) |
| \`datetime\` | string | Temporal filter (ISO 8601) |
| \`filter\` | string | CQL2 filter expression |
| \`filter-lang\` | string | Filter language (e.g., 'cql2-text') |
| \`sortby\` | string | Sort by properties (+prop or -prop) |
| \`properties\` | string | Comma-separated list of properties to return |
| \`skip-geometry\` | boolean | Skip geometry in response |

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
  BaseProvider,
  OGCFeaturesConfig,
  OGCAPIConformanceClass,
  Feature,
  FeatureCollection,
  Collection,
  QueryParams
} from 'express-ogc-api';
```

## Conformance Classes

The \`InMemoryProvider\` implements the following OGC API conformance classes:

- \`http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/core\`
- \`http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/landing-page\`
- \`http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/json\`
- \`http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core\`
- \`http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson\`

## Development

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run tests
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

- Node.js >= 18.0.0
- Express.js >= 4.18.0 or >= 5.0.0

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

**Provider methods now take the Express request first.** \`getCollections\`,
\`getCollection\`, \`getFeatures\`, \`getFeature\`, \`getSchema\`, \`getQueryables\`,
\`createFeature\`, \`replaceFeature\`, \`updateFeature\` and \`deleteFeature\` all gained
a leading \`req\` parameter. \`conformanceClasses\`, \`addCollection\` and \`addFeature\`
are unchanged — they run outside a request. If a provider calls its own methods
internally, thread \`req\` through those calls too.

**\`preProviderHook\` / \`postProviderHook\` / \`setupProviderHooks\` are gone.** Use
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

**\`basePath\` is now an override, not the mount path.** If you set it to the same
value you mount at, nothing changes and you can delete it. Do not set it when
mounting at a parametrized path — it cannot know the resolved param values.

## License

MIT © Majid Hojati

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Related Projects

- [OGC API Standards](https://ogcapi.ogc.org/)
- [Express.js](https://expressjs.com/)

## Support

For issues and questions, please use the [GitHub issue tracker](https://github.com/am2222/express-ogc-api/issues).
