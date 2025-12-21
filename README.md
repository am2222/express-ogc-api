# OGC API Features Middleware Documentation

## Overview

This TypeScript library provides a complete implementation of the OGC API - Features standard for Express.js applications. It offers a flexible, extensible architecture for serving geospatial feature data through standardized REST APIs.

## Architecture

### Core Components

#### 1. **OGCFeaturesBackend (Abstract Class)**
The foundation that defines how your application interacts with feature data. You extend this class to connect to your specific data source (database, file system, external API, etc.).

#### 2. **OGCFeaturesMiddleware**
The Express middleware that handles all HTTP requests and routes them appropriately. It manages the OGC API specification compliance and delegates data operations to your backend implementation.

#### 3. **InMemoryBackend (Example Implementation)**
A complete reference implementation using in-memory storage, demonstrating how to implement all features of the abstract backend.

## Quick Start

### Basic Setup

```typescript
import express from 'express';
import { OGCFeaturesMiddleware, InMemoryBackend } from './ogc-features';

// Create your backend
const backend = new InMemoryBackend();

// Add a collection
backend.addCollection({
  id: 'cities',
  title: 'World Cities',
  description: 'Major cities around the world',
  extent: {
    spatial: {
      bbox: [[-180, -90, 180, 90]]
    }
  }
});

// Add some features
backend.addFeature('cities', {
  type: 'Feature',
  id: 'tokyo',
  geometry: {
    type: 'Point',
    coordinates: [139.6917, 35.6895]
  },
  properties: {
    name: 'Tokyo',
    population: 13960000,
    country: 'Japan'
  }
});

// Create middleware with configuration
const ogcMiddleware = new OGCFeaturesMiddleware({
  backend: backend,
  basePath: '/api/ogc',
  title: 'My Geospatial API',
  description: 'OGC API - Features implementation',
  defaultLimit: 10,
  maxLimit: 1000,
  enableFiltering: true,
  enableTransactions: true,
  enableCrs: true,
  enableSchemas: true,
  enablePropertySelection: true,
  enableSorting: true
});

// Mount in Express app
const app = express();
app.use(express.json());
app.use('/api/ogc', ogcMiddleware.getRouter());

app.listen(3000, () => {
  console.log('OGC API server running on http://localhost:3000/api/ogc');
});
```

## API Endpoints

### Core Endpoints (Part 1)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Landing page with API metadata |
| `/conformance` | GET | Conformance classes the API supports |
| `/collections` | GET | List all feature collections |
| `/collections/{collectionId}` | GET | Get specific collection metadata |
| `/collections/{collectionId}/items` | GET | Query features in a collection |
| `/collections/{collectionId}/items/{featureId}` | GET | Get a specific feature |

### Query Parameters

**Pagination:**
- `limit` - Maximum number of features to return (default: 10, max: 1000)
- `offset` - Number of features to skip (default: 0)

**Spatial Filter:**
- `bbox` - Bounding box: `minX,minY,maxX,maxY` (e.g., `-10,40,10,50`)
- `bbox-crs` - Coordinate reference system for bbox (when CRS enabled)

**Temporal Filter:**
- `datetime` - Date/time filter (ISO 8601 format)

**Advanced Filtering (Part 3):**
- `filter` - CQL2 filter expression (e.g., `population > 1000000`)
- `filter-lang` - Filter language: `cql2-text` or `cql2-json`
- `filter-crs` - CRS for geometric filter predicates

**Property Selection (Part 6):**
- `properties` - Comma-separated list of properties to return (e.g., `name,population`)

**Geometry Options (Part 7):**
- `skip-geometry` - Set to `true` to exclude geometry from response
- `max-allowable-offset` - Geometry simplification tolerance

**Sorting (Part 8):**
- `sortby` - Sort expression (e.g., `+name,-population`)

### CRUD Operations (Part 4)

When `enableTransactions: true`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/collections/{collectionId}/items` | POST | Create new feature |
| `/collections/{collectionId}/items/{featureId}` | PUT | Replace entire feature |
| `/collections/{collectionId}/items/{featureId}` | PATCH | Update feature properties |
| `/collections/{collectionId}/items/{featureId}` | DELETE | Delete feature |

### Schema Endpoints (Part 5)

When `enableSchemas: true`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/collections/{collectionId}/schema` | GET | Get JSON Schema for collection |

### Filtering Endpoints (Part 3)

When `enableFiltering: true`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/collections/{collectionId}/queryables` | GET | Get queryable properties schema |
| `/functions` | GET | Get available CQL2 functions |

## Configuration Options

```typescript
interface OGCFeaturesConfig {
  backend: OGCFeaturesBackend;           // Your data backend
  basePath?: string;                     // Base URL path (default: '/')
  title?: string;                        // API title
  description?: string;                  // API description
  defaultLimit?: number;                 // Default page size (default: 10)
  maxLimit?: number;                     // Maximum page size (default: 1000)
  supportedCrs?: string[];              // Supported CRS list
  defaultCrs?: string;                   // Default CRS
  enableTransactions?: boolean;          // Enable POST/PUT/PATCH/DELETE (default: false)
  enableFiltering?: boolean;             // Enable CQL2 filtering (default: false)
  enableCrs?: boolean;                   // Enable CRS support (default: false)
  enablePropertySelection?: boolean;     // Enable property selection (default: false)
  enableSorting?: boolean;              // Enable sorting (default: false)
  enableSchemas?: boolean;              // Enable schema endpoints (default: false)
}
```

## Implementing a Custom Backend

### Minimal Implementation

You must implement these four core methods:

```typescript
import { OGCFeaturesBackend, Collection, Feature, FeatureCollection, QueryParams } from './ogc-features';

export class DatabaseBackend extends OGCFeaturesBackend {
  async getCollections(): Promise<Collection[]> {
    // Return array of all collections
    const results = await db.query('SELECT * FROM collections');
    return results.map(row => ({
      id: row.id,
      title: row.title,
      description: row.description
    }));
  }

  async getCollection(collectionId: string): Promise<Collection | null> {
    // Return specific collection or null
    const result = await db.query(
      'SELECT * FROM collections WHERE id = $1',
      [collectionId]
    );
    return result.rows[0] || null;
  }

  async getFeatures(
    collectionId: string,
    params: QueryParams
  ): Promise<FeatureCollection> {
    // Query features with filters, pagination, etc.
    let query = `SELECT * FROM features WHERE collection_id = $1`;
    const values: any[] = [collectionId];
    
    // Apply bbox filter
    if (params.bbox) {
      query += ` AND ST_Intersects(
        geometry,
        ST_MakeEnvelope($2, $3, $4, $5, 4326)
      )`;
      values.push(
        params.bbox.minX,
        params.bbox.minY,
        params.bbox.maxX,
        params.bbox.maxY
      );
    }
    
    // Apply pagination
    query += ` LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
    values.push(params.limit, params.offset || 0);
    
    const results = await db.query(query, values);
    const countResult = await db.query(
      'SELECT COUNT(*) FROM features WHERE collection_id = $1',
      [collectionId]
    );
    
    return {
      type: 'FeatureCollection',
      features: results.rows,
      numberMatched: parseInt(countResult.rows[0].count),
      numberReturned: results.rows.length
    };
  }

  async getFeature(
    collectionId: string,
    featureId: string
  ): Promise<Feature | null> {
    // Return specific feature or null
    const result = await db.query(
      'SELECT * FROM features WHERE collection_id = $1 AND id = $2',
      [collectionId, featureId]
    );
    return result.rows[0] || null;
  }
}
```

### Optional Methods

Override these for additional functionality:

```typescript
// Part 3: Filtering
async getQueryables(collectionId: string): Promise<Queryable> {
  // Define which properties can be used in filter expressions
}

async getFunctions(): Promise<FunctionMetadata[]> {
  // Define available CQL2 functions
}

// Part 4: CRUD Operations
async createFeature(collectionId: string, feature: Feature): Promise<Feature | null> {
  // Insert new feature
}

async replaceFeature(collectionId: string, featureId: string, feature: Feature): Promise<Feature | null> {
  // Replace entire feature
}

async updateFeature(collectionId: string, featureId: string, params: UpdateFeatureParams): Promise<Feature | null> {
  // Partial update of feature
}

async deleteFeature(collectionId: string, featureId: string): Promise<boolean> {
  // Delete feature
}

// Part 5: Schemas
async getSchema(collectionId: string): Promise<any> {
  // Return JSON Schema for collection
}
```

## Data Types

### Collection

```typescript
interface Collection {
  id: string;                    // Unique collection identifier
  title?: string;                // Human-readable title
  description?: string;          // Collection description
  links?: Link[];               // Related links
  extent?: {                    // Spatial and temporal extent
    spatial?: {
      bbox: number[][];         // Bounding boxes
      crs?: string;             // CRS for bbox
    };
    temporal?: {
      interval: (string | null)[][];  // Time intervals
      trs?: string;                   // Temporal reference system
    };
  };
  itemType?: string;            // Type of items (usually 'feature')
  crs?: string[];               // Supported CRS
  storageCrs?: string;          // Storage CRS
}
```

### Feature

```typescript
interface Feature {
  type: 'Feature';
  id: string | number;           // Feature identifier
  geometry: any;                 // GeoJSON geometry
  properties: Record<string, any>; // Feature properties
  links?: Link[];               // Related links
}
```

### QueryParams

```typescript
interface QueryParams {
  limit?: number;                // Page size
  offset?: number;               // Skip count
  bbox?: BBox;                   // Spatial filter
  bboxCrs?: string;             // CRS for bbox
  datetime?: string;            // Temporal filter
  properties?: string[];        // Property selection
  crs?: string;                 // Response CRS
  filter?: string;              // CQL2 filter
  filterLang?: 'cql2-text' | 'cql2-json';
  filterCrs?: string;           // CRS for filter
  sortby?: string;              // Sort expression
  skipGeometry?: boolean;       // Exclude geometry
  maxAllowableOffset?: number;  // Simplification tolerance
}
```

## Example Use Cases

### 1. Simple Read-Only API

```typescript
const middleware = new OGCFeaturesMiddleware({
  backend: myBackend,
  defaultLimit: 50,
  maxLimit: 5000
  // All optional features disabled by default
});
```

### 2. Full-Featured API with All Extensions

```typescript
const middleware = new OGCFeaturesMiddleware({
  backend: myBackend,
  enableFiltering: true,
  enableTransactions: true,
  enableCrs: true,
  enablePropertySelection: true,
  enableSorting: true,
  enableSchemas: true,
  supportedCrs: [
    'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
    'http://www.opengis.net/def/crs/EPSG/0/4326',
    'http://www.opengis.net/def/crs/EPSG/0/3857'
  ]
});
```

### 3. Query Examples

**Get features with bounding box:**
```
GET /collections/cities/items?bbox=-10,40,10,50&limit=100
```

**Filter by property:**
```
GET /collections/cities/items?filter=population > 1000000
```

**Select specific properties:**
```
GET /collections/cities/items?properties=name,population,country
```

**Sort results:**
```
GET /collections/cities/items?sortby=-population,+name
```

**Create new feature:**
```
POST /collections/cities/items
Content-Type: application/json

{
  "type": "Feature",
  "geometry": {
    "type": "Point",
    "coordinates": [139.6917, 35.6895]
  },
  "properties": {
    "name": "Tokyo",
    "population": 13960000
  }
}
```

## Conformance Classes

The middleware automatically declares conformance to OGC standards based on enabled features:

- **Core**: Always included (Part 1)
- **CRS**: When `enableCrs: true` (Part 2)
- **Filtering & CQL2**: When `enableFiltering: true` (Part 3)
- **Transactions**: When `enableTransactions: true` (Part 4)
- **Schemas**: When `enableSchemas: true` (Part 5)
- **Property Selection**: When `enablePropertySelection: true` (Part 6)
- **Sorting**: When `enableSorting: true` (Part 8)

## Error Handling

The middleware uses Express error handling middleware. Errors are passed to `next(err)`:

```typescript
app.use('/api/ogc', ogcMiddleware.getRouter());

// Add error handler after mounting middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});
```

## Troubleshooting

### "Could not find a root JSON document containing both a link with rel='data' and a link with rel='service-desc'"

This error occurs when the landing page (root endpoint `/`) doesn't include the required links. The OGC API Features specification requires:

- A link with `rel='data'` (pointing to `/collections`)
- A link with `rel='service-desc'` (API definition/OpenAPI spec)
- A link with `rel='service-doc'` (human-readable documentation)

**Solution**: The fixed `handleLandingPage` method now includes these required links:

```typescript
{
  href: this.buildUrl(req, '/collections'),
  rel: 'data',
  type: 'application/json',
  title: 'Collections'
},
{
  href: 'https://schemas.opengis.net/ogcapi/features/part1/1.0/openapi/ogcapi-features-1.yaml',
  rel: 'service-desc',
  type: 'application/vnd.oai.openapi+json;version=3.0',
  title: 'API definition'
},
{
  href: 'https://docs.ogc.org/is/17-069r4/17-069r4.html',
  rel: 'service-doc',
  type: 'text/html',
  title: 'API documentation'
}
```

### Custom OpenAPI Documentation

To provide your own OpenAPI spec instead of linking to the standard:

```typescript
// Add an OpenAPI endpoint
app.get('/api/ogc/api', (req, res) => {
  res.json({
    openapi: '3.0.0',
    info: {
      title: 'My OGC API',
      version: '1.0.0'
    },
    // ... rest of your OpenAPI spec
  });
});

// Then modify handleLandingPage to link to it:
{
  href: this.buildUrl(req, '/api'),
  rel: 'service-desc',
  type: 'application/vnd.oai.openapi+json;version=3.0',
  title: 'API definition'
}
```

## Best Practices

1. **Implement pagination properly** - Always respect `limit` and `offset` parameters
2. **Use database indexes** - Index geometry columns and frequently filtered properties
3. **Validate input** - Check collection IDs and feature IDs exist before operations
4. **Handle CRS transformations** - Transform geometries when `crs` parameter is used
5. **Set appropriate limits** - Don't allow unlimited result sets
6. **Add spatial indexes** - Use R-tree or similar for bbox queries
7. **Cache collection metadata** - Collections change infrequently
8. **Monitor performance** - Log slow queries and optimize

## License & Standards

This implementation follows:
- OGC API - Features - Part 1: Core
- OGC API - Features - Part 2: Coordinate Reference Systems
- OGC API - Features - Part 3: Filtering
- OGC API - Features - Part 4: Create, Replace, Update and Delete
- OGC API - Features - Part 5: Schemas
- OGC API - Features - Part 6: Property Selection
- OGC API - Features - Part 8: Sorting

For full specification details, visit: https://ogcapi.ogc.org/features/