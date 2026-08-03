
// biome-ignore assist/source/organizeImports: <explanation>
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { OGCAPI, InMemoryProvider } from '../src/index.js';

describe('OGC API LandingPage', () => {
  let app: express.Express;
  let server: import('http').Server;
  let baseUrl: string;

  beforeAll(() => {
    app = express();
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

    const ogcAPIRoutes = new OGCAPI(
      memoryProvider,app, {
      basePath: '/ogc',
      title: 'Test API',
      description: 'Test Description',
    });
    app.use('/ogc', ogcAPIRoutes.getRouter());
    server = app.listen(0);
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server?.close();
  });

  it('should return landing page', async () => {
    const response = await fetch(`${baseUrl}/ogc`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.title).toBe('Test API');
    expect(data.description).toBe('Test Description');
    expect(Array.isArray(data.links)).toBe(true);
  });

  it('should return conformance declaration', async () => {
    const response = await fetch(`${baseUrl}/ogc/conformance`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(Array.isArray(data.conformsTo)).toBe(true);
    expect(data.conformsTo.length).toBeGreaterThan(0);
  });


  it('should set CORS headers', async () => {
    const response = await fetch(`${baseUrl}/ogc`, { method: 'OPTIONS' });

    expect(
      response.headers.get('Allow')
    ).toBe('GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE');
  });
});