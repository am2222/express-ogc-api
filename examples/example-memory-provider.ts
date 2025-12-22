
import express from 'express';
import { OGCAPI, InMemoryProvider } from '../src/index.js';

const app = express();
const port = process.env.PORT || 3001;

// Create an in-memory provider
const memoryProvider = new InMemoryProvider();

// Add sample collection
memoryProvider.addCollection({
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
    memoryProvider.addFeature('cities', {
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

// Create OGC API instance
const ogcAPI = new OGCAPI(memoryProvider, app, {
    basePath: '/ogc',
    title: 'World Cities OGC API',
    description: 'Example OGC API Features server with in-memory provider',
});

// Mount the OGC API router
app.use('/ogc', ogcAPI.getRouter());
app.use('/', (req, res) => {
    res.send('Welcome to the OGC API Features Example Server! Visit /ogc for the API endpoints.');
});

// Start the server
const server = app.listen(port, () => {
    console.log('🌍 OGC API Features Server Started');
    console.log('================================');
    console.log(`Server running at http://localhost:${port}`);
    console.log('');
    console.log('Available endpoints:');
    console.log(`  Landing Page:  http://localhost:${port}/ogc`);
    console.log(`  Conformance:   http://localhost:${port}/ogc/conformance`);
    console.log(`  Collections:   http://localhost:${port}/ogc/collections`);
    console.log(`  Cities:        http://localhost:${port}/ogc/collections/cities`);
    console.log(`  Features:      http://localhost:${port}/ogc/collections/cities/items`);
    console.log('');
    console.log('Press Ctrl+C to stop the server');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('\n🛑 SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('✅ HTTP server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('\n🛑 SIGINT signal received: closing HTTP server');
    server.close(() => {
        console.log('✅ HTTP server closed');
        process.exit(0);
    });
});