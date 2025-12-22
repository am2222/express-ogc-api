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
const ogcAPI = new OGCAPI(provider, {
  basePath: '/ogc',
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
new OGCAPI(provider: BaseProvider, options?: OGCFeaturesConfig)
```

**Parameters:**
- \`provider\` - An instance of \`BaseProvider\` or its subclass (e.g., \`InMemoryProvider\`)
- \`options\` - Optional configuration object

### Configuration Options

```typescript
interface OGCFeaturesConfig {
  basePath?: string;      // Base path for the API (default: '/')
  title?: string;         // API title for landing page
  description?: string;   // API description
}
```

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

Extend \`BaseProvider\` to create custom data sources:

```typescript
import { BaseProvider } from 'express-ogc-api';

class MyCustomProvider extends BaseProvider {
  constructor() {
    super({ name: 'MyCustomProvider' });
  }

  conformanceClasses() {
    return [
      OGCAPIConformanceClass.COMMON_CORE,
      OGCAPIConformanceClass.FEATURES_CORE,
      // ... other conformance classes
    ];
  }

  async getCollections() {
    // Return collections from your data source
  }

  async getFeatures(collectionId, params) {
    // Return features from your data source
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
  Collection
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

## License

MIT © Majid Hojati

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Related Projects

- [OGC API Standards](https://ogcapi.ogc.org/)
- [Express.js](https://expressjs.com/)

## Support

For issues and questions, please use the [GitHub issue tracker](https://github.com/am2222/express-ogc-api/issues).
