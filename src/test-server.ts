import express from 'express';
import { OGCFeaturesMiddleware } from './ogc-middleware.js';
import { InMemoryBackend } from './backends/in-memory.js';
import cors from 'cors';
import compression from 'compression';
const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON bodies
app.use(express.json());

app.use(cors({
  origin: '*',  // Or your specific origins
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Authorization'],
  preflightContinue: true,  // Key: Lets explicit OPTIONS handlers run
  optionsSuccessStatus: 200  // Sets status to 200 (optional, but aligns with OGC)
}));
// Create backend with sample data
const backend = new InMemoryBackend();

// Add sample collection
backend.addCollection({
  id: 'cities',
  title: 'World Cities',
  description: 'Major cities worldwide with population data',
  crs: [
    'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
    'http://www.opengis.net/def/crs/EPSG/0/4326'
  ],
  storageCrs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
  extent: {
    spatial: {
      bbox: [[-180, -90, 180, 90]],
      crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84'
    },
    temporal: {
      interval: [['1776-06-29T00:00:00Z', null]]
    }
  }
});

// Add sample features
const sampleCities = [
  {
    id: 'sf',
    name: 'San Francisco',
    coordinates: [-122.4194, 37.7749],
    population: 883305,
    country: 'USA',
    founded: '1776-06-29'
  },
  {
    id: 'nyc',
    name: 'New York City',
    coordinates: [-74.0060, 40.7128],
    population: 8336817,
    country: 'USA',
    founded: '1624-01-01'
  },
  {
    id: 'london',
    name: 'London',
    coordinates: [-0.1276, 51.5074],
    population: 9002488,
    country: 'UK',
    founded: '0043-01-01'
  },
  {
    id: 'tokyo',
    name: 'Tokyo',
    coordinates: [139.6917, 35.6895],
    population: 13960000,
    country: 'Japan',
    founded: '1603-01-01'
  },
  {
    id: 'paris',
    name: 'Paris',
    coordinates: [2.3522, 48.8566],
    population: 2161000,
    country: 'France',
    founded: '0250-01-01'
  }
];

sampleCities.forEach(city => {
  backend.addFeature('cities', {
    type: 'Feature',
    id: city.id,
    geometry: {
      type: 'Point',
      coordinates: city.coordinates
    },
    properties: {
      name: city.name,
      population: city.population,
      country: city.country,
      founded: city.founded
    }
  });
});

// Create middleware with all features enabled
const ogcMiddleware = new OGCFeaturesMiddleware({
  backend,
  basePath: '',
  title: 'OGC API - Features Test Server',
  description: 'A test implementation of OGC API - Features with all extensions',
  defaultLimit: 10,
  maxLimit: 100,
  enableTransactions: true,     // Part 4: CRUD operations
  enableFiltering: true,        // Part 3: CQL2 filtering
  enableCrs: true,              // Part 2: CRS support
  enablePropertySelection: true, // Part 6: Property selection
  enableSorting: true,          // Part 8: Sorting
  enableSchemas: true,           // Part 5: Schemas
  app: app                     // Pass the Express
});

app.use(compression());
// Mount OGC API
app.use('/', ogcMiddleware.getRouter());

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({
    error: err.message || 'Internal server error'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 OGC API - Features server running!`);
  console.log(`\n📍 Available endpoints:`);
  console.log(`   Landing page:     http://localhost:${PORT}/`);
  console.log(`   Conformance:      http://localhost:${PORT}/conformance`);
  console.log(`   Collections:      http://localhost:${PORT}/collections`);
  console.log(`   Cities:           http://localhost:${PORT}/collections/cities`);
  console.log(`   City items:       http://localhost:${PORT}/collections/cities/items`);
  console.log(`   Queryables:       http://localhost:${PORT}/collections/cities/queryables`);
  console.log(`   Schema:           http://localhost:${PORT}/collections/cities/schema`);
  console.log(`\n🔍 Example queries:`);
  console.log(`   Filter:           http://localhost:${PORT}/collections/cities/items?filter=population>5000000`);
  console.log(`   Sort:             http://localhost:${PORT}/collections/cities/items?sortby=-population`);
  console.log(`   Properties:       http://localhost:${PORT}/collections/cities/items?properties=name,population`);
  console.log(`   Bbox:             http://localhost:${PORT}/collections/cities/items?bbox=-180,-90,0,90`);
  console.log(`   Limit:            http://localhost:${PORT}/collections/cities/items?limit=2`);
  console.log(`\n💡 CRUD operations:`);
  console.log(`   POST   /collections/cities/items`);
  console.log(`   PUT    /collections/cities/items/{id}`);
  console.log(`   PATCH  /collections/cities/items/{id}`);
  console.log(`   DELETE /collections/cities/items/{id}`);
  console.log(`\n`);
});

export default app;