# express-ogc-api

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

Modern Express.js middleware for implementing [OGC API](https://ogcapi.ogc.org/) standards.

## Features

✨ **Modern** - Built with TypeScript and ES Modules  
🚀 **Simple** - Easy to integrate with existing Express applications  
📦 **Lightweight** - Minimal dependencies  
🌍 **Standards-compliant** - Implements OGC API Common standards  
🔧 **Configurable** - Flexible options for customization  

## Installation

```bash
npm install express-ogc-api
```

## Quick Start

```javascript
import express from 'express';
import { ogcApiMiddleware } from 'express-ogc-api';

const app = express();

// Add OGC API middleware
app.use(ogcApiMiddleware({
  basePath: '/ogc',
  title: 'My Geospatial API',
  description: 'OGC API implementation',
  cors: true
}));

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
  console.log('OGC API available at http://localhost:3000/ogc');
});
```

## API Endpoints

The middleware automatically creates the following OGC API endpoints:

- **`GET /ogc/`** - Landing page with API links
- **`GET /ogc/conformance`** - Conformance declaration
- **`GET /ogc/api`** - OpenAPI 3.0 definition

## Configuration Options

### `ogcApiMiddleware(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `basePath` | `string` | `'/ogc'` | Base path for OGC API endpoints |
| `cors` | `boolean` | `true` | Enable CORS headers |
| `title` | `string` | `'OGC API'` | API title for landing page |
| `description` | `string` | `'OGC API implementation'` | API description |
| `conformsTo` | `string[]` | See below | Custom conformance classes |

### Default Conformance Classes

```javascript
[
  'http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/core',
  'http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/landing-page',
  'http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/json'
]
```

## TypeScript Support

This package is written in TypeScript and includes type definitions out of the box.

```typescript
import express from 'express';
import { ogcApiMiddleware, OgcApiOptions } from 'express-ogc-api';

const options: OgcApiOptions = {
  basePath: '/ogc',
  title: 'My API',
  cors: true
};

const app = express();
app.use(ogcApiMiddleware(options));
```

## Examples

See the [examples](./examples) directory for more usage examples.

### Basic Example

```javascript
import express from 'express';
import { ogcApiMiddleware } from 'express-ogc-api';

const app = express();

app.use(ogcApiMiddleware({
  basePath: '/ogc',
  title: 'My Geospatial API',
  description: 'An example OGC API implementation'
}));

app.listen(3000);
```

### Custom Conformance Classes

```javascript
app.use(ogcApiMiddleware({
  basePath: '/api',
  conformsTo: [
    'http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/core',
    'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core',
    'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson'
  ]
}));
```

## Requirements

- Node.js >= 18.0.0
- Express.js >= 4.18.0 or >= 5.0.0

## Development

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run linter
npm run lint

# Format code
npm run format

# Development mode (watch)
npm run dev
```

## Standards

This middleware implements the [OGC API - Common](https://ogcapi.ogc.org/common/) standard, providing:

- Landing page with API links
- Conformance declaration
- OpenAPI 3.0 definition

## License

MIT © Majid Hojati

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Related Projects

- [OGC API Standards](https://ogcapi.ogc.org/)
- [Express.js](https://expressjs.com/)

## Support

For issues and questions, please use the [GitHub issue tracker](https://github.com/am2222/express-ogc-api/issues).
