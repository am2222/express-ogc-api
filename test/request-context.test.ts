import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { OGCAPI } from '../src/index.js';
import { RecordingProvider } from './helpers/recording-provider.js';

function seed(provider: RecordingProvider): void {
  provider.addCollection({
    id: 'cities',
    title: 'Cities',
    extent: {
      spatial: {
        bbox: [[-180, -90, 180, 90]],
        crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
      },
    },
  });
  for (const [id, name, lon, lat] of [
    ['sf', 'San Francisco', -122.4194, 37.7749],
    ['nyc', 'New York City', -74.006, 40.7128],
    ['london', 'London', -0.1276, 51.5074],
  ] as const) {
    provider.addFeature('cities', {
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { name },
    });
  }
}

describe('request reaches the provider', () => {
  let server: import('http').Server;
  let baseUrl: string;
  let provider: RecordingProvider;

  beforeAll(() => {
    const app = express();
    provider = new RecordingProvider();
    seed(provider);

    const ogc = new OGCAPI(provider, app, { title: 'Tenant API' });
    app.use('/root/:dbid', ogc.getRouter());

    server = app.listen(0);
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => server?.close());

  it('passes the collection id on a collection metadata request', async () => {
    provider.calls = [];
    const res = await fetch(`${baseUrl}/root/db1/collections/cities`);

    expect(res.status).toBe(200);
    expect(provider.callsTo('getCollection')[0]?.params.collectionId).toBe('cities');
  });

  it('passes the feature id on a single feature request', async () => {
    provider.calls = [];
    const res = await fetch(`${baseUrl}/root/db1/collections/cities/items/sf`);

    expect(res.status).toBe(200);
    expect(provider.callsTo('getFeature')[0]?.params.featureId).toBe('sf');
  });
});
