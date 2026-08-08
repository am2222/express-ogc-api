
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

  // QGIS's OGC API - Features provider (3.44+, PR #61119) only ever fetches
  // GET /collections/{id}/schema when /conformance advertises this exact
  // class. Without it, everything `getSchema` publishes is invisible to
  // QGIS regardless of what the collection's link relation says.
  it('advertises the Part 5 "Schemas" conformance class', async () => {
    const response = await fetch(`${baseUrl}/ogc/conformance`);
    const data = (await response.json()) as { conformsTo: string[] };

    expect(data.conformsTo).toContain(
      'http://www.opengis.net/spec/ogcapi-features-5/1.0/conf/schemas'
    );
  });

  it('serves the schema endpoint as application/schema+json, not application/json', async () => {
    const response = await fetch(`${baseUrl}/ogc/collections/cities/schema`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/schema\+json/);
  });

  it('serves the queryables endpoint as application/schema+json, not application/json', async () => {
    const response = await fetch(`${baseUrl}/ogc/collections/cities/queryables`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/schema\+json/);
  });

  // Regression guard: adding a conformance class to the array `conformance
  // Classes()` returns must not change which handlers register their routes
  // — `RootHandler`/`CollectionHandler`/`ItemsCURDHandler`/`SchemaHandler`
  // each gate registration on `isProviderConformed()`, and none of their
  // `requiredCoreClasses` lists (nor the schema handler's `enableSchemas`
  // check) depend on the new class being absent. If any of these gates
  // regressed, one of the following would 404 instead of 200.
  it('still registers every route after adding the schemas conformance class (regression guard)', async () => {
    const endpoints = [
      '/ogc',
      '/ogc/conformance',
      '/ogc/collections',
      '/ogc/collections/cities',
      '/ogc/collections/cities/items',
      '/ogc/collections/cities/items/sf',
      '/ogc/collections/cities/queryables',
      '/ogc/collections/cities/schema',
    ];

    for (const endpoint of endpoints) {
      const response = await fetch(`${baseUrl}${endpoint}`);
      expect(response.status, `GET ${endpoint}`).toBe(200);
    }
  });

  it('applies a PATCH sent as application/merge-patch+json', async () => {
    // The content type OGC API - Features Part 4 specifies for PATCH. The
    // built-in body parser used to accept only application/json and
    // application/geo+json, so a spec-compliant PATCH arrived with an unparsed
    // (empty) body: `updateFeature` saw no properties to set, took its
    // "nothing to update" early return, and answered 204 — a silent no-op that
    // looks exactly like success to the client.
    const response = await fetch(`${baseUrl}/ogc/collections/cities/items/sf`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/merge-patch+json' },
      body: JSON.stringify({ properties: { population: 999333 } }),
    });

    expect(response.status).toBe(204);

    const updated = await (
      await fetch(`${baseUrl}/ogc/collections/cities/items/sf`)
    ).json();
    expect(updated.properties.population).toBe(999333);
  });

  it('should set CORS headers', async () => {
    const response = await fetch(`${baseUrl}/ogc`, { method: 'OPTIONS' });

    expect(
      response.headers.get('Allow')
    ).toBe('GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE');
  });

  it('should return 404, not 500, for a nonexistent feature (F3)', async () => {
    const response = await fetch(`${baseUrl}/ogc/collections/cities/items/does-not-exist`);

    expect(response.status).toBe(404);
  });

  describe('InMemoryProvider CQL2 filter — fail loud, not unfiltered (Part 3)', () => {
    it('an expression the regex evaluator genuinely handles still filters correctly', async () => {
      // population > 5000000 matches NYC (8,336,817), London (9,002,488) and
      // Tokyo (13,960,000); SF (883,305) and Paris (2,161,000) do not. Both
      // `features` and `numberMatched` are checked — a stub that ignored the
      // filter but still counted every feature would pass a
      // features-length-only assertion.
      const response = await fetch(
        `${baseUrl}/ogc/collections/cities/items?${new URLSearchParams({ filter: 'population > 5000000' })}`
      );
      const body = (await response.json()) as {
        features: Array<{ properties: { name: string } }>;
        numberMatched: number;
      };

      expect(response.status).toBe(200);
      expect(body.features.map((f) => f.properties.name).sort()).toEqual([
        'London',
        'New York City',
        'Tokyo',
      ]);
      expect(body.numberMatched).toBe(3);
    });

    it('an expression the regex evaluator cannot handle is a 400, not silently unfiltered results', async () => {
      // A compound expression — neither regex matches the whole string.
      // Before this fix, InMemoryProvider.applyFilter fell through to
      // `return features`: all 5 cities, unfiltered, with a 200. Now it must
      // reject instead of silently over-returning.
      const response = await fetch(
        `${baseUrl}/ogc/collections/cities/items?${new URLSearchParams({
          filter: "population > 1000000 AND country = 'USA'",
        })}`
      );
      const body = (await response.json()) as { code: string; description: string };

      expect(response.status).toBe(400);
      // Not a 200 with all 5 cities back.
      expect(response.status).not.toBe(200);
      expect(body.description).toContain('cannot evaluate');
    });

    it('an unparseable filter is also a 400, not a console.error-and-unfiltered fallback', async () => {
      const response = await fetch(
        `${baseUrl}/ogc/collections/cities/items?${new URLSearchParams({ filter: '!!!not cql2 at all!!!' })}`
      );

      expect(response.status).toBe(400);
    });
  });
});