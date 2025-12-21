import express from 'express';
import { ogcApiMiddleware } from '../dist/index.js';

const app = express();
const port = 3000;

// Use the OGC API middleware
app.use(
  ogcApiMiddleware({
    basePath: '/ogc',
    title: 'My Geospatial API',
    description: 'An example OGC API implementation using express-ogc-api',
    cors: true,
  })
);

// Additional custom routes
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to the Geospatial API',
    ogcApi: '/ogc',
  });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`OGC API available at http://localhost:${port}/ogc`);
});
