import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { OGCAPI } from '../src/index.js';
import { RecordingProvider } from './helpers/recording-provider.js';

interface LinkLike {
  rel: string;
  href: string;
}

interface CollectionsResponseBody {
  links: LinkLike[];
  collections: { links: LinkLike[] }[];
}

interface ItemsResponseBody {
  links: LinkLike[];
}

interface OpenAPIResponseBody {
  servers: { url: string }[];
}

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

  it('passes the mount param to the provider', async () => {
    provider.calls = [];
    const res = await fetch(`${baseUrl}/root/db1/collections`);

    expect(res.status).toBe(200);
    expect(provider.callsTo('getCollections')[0]?.params.dbid).toBe('db1');
  });

  it('keeps tenants isolated across sequential requests', async () => {
    provider.calls = [];
    await fetch(`${baseUrl}/root/db1/collections`);
    await fetch(`${baseUrl}/root/db2/collections`);

    expect(provider.callsTo('getCollections').map((c) => c.params.dbid)).toEqual([
      'db1',
      'db2',
    ]);
  });

  it('keeps tenants isolated across concurrent requests', async () => {
    provider.calls = [];
    await Promise.all([
      fetch(`${baseUrl}/root/db1/collections/cities`),
      fetch(`${baseUrl}/root/db2/collections/cities`),
    ]);

    const seen = provider.callsTo('getCollection').map((c) => c.params.dbid).sort();
    expect(seen).toEqual(['db1', 'db2']);
  });

  it('builds collection links from the resolved mount path', async () => {
    const res = await fetch(`${baseUrl}/root/db1/collections`);
    const body = (await res.json()) as CollectionsResponseBody;

    const self = body.links.find((l) => l.rel === 'self');
    expect(self?.href).toContain('/root/db1/collections');
    expect(self?.href).not.toContain(':dbid');

    const items = body.collections[0]?.links.find((l) => l.rel === 'items');
    expect(items?.href).toContain('/root/db1/collections/cities/items');
  });

  it('builds pagination links from the resolved mount path', async () => {
    const res = await fetch(`${baseUrl}/root/db1/collections/cities/items?limit=1&offset=1`);
    const body = (await res.json()) as ItemsResponseBody;

    const rels = Object.fromEntries(body.links.map((l) => [l.rel, l.href]));
    expect(rels.next).toContain('/root/db1/collections/cities/items');
    expect(rels.prev).toContain('/root/db1/collections/cities/items');
    expect(rels.next).not.toContain(':dbid');
  });

  it('serves an OpenAPI document scoped to the tenant', async () => {
    const one = (await (await fetch(`${baseUrl}/root/db1/api`)).json()) as OpenAPIResponseBody;
    const two = (await (await fetch(`${baseUrl}/root/db2/api`)).json()) as OpenAPIResponseBody;

    expect(one.servers[0].url).toBe('/root/db1');
    expect(two.servers[0].url).toBe('/root/db2');
  });
});

describe('basePath override', () => {
  let server: import('http').Server;
  let baseUrl: string;

  beforeAll(() => {
    const app = express();
    const provider = new RecordingProvider();
    seed(provider);

    const ogc = new OGCAPI(provider, app, { basePath: '/public/ogc' });
    app.use('/internal', ogc.getRouter());

    server = app.listen(0);
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => server?.close());

  it('prefers the configured basePath over the mount path', async () => {
    const res = await fetch(`${baseUrl}/internal/collections`);
    const body = (await res.json()) as CollectionsResponseBody;

    const self = body.links.find((l) => l.rel === 'self');
    expect(self?.href).toContain('/public/ogc/collections');
    expect(self?.href).not.toContain('/internal');
  });
});

describe('application middleware integration', () => {
  let server: import('http').Server;
  let baseUrl: string;
  let provider: RecordingProvider;

  beforeAll(() => {
    const app = express();
    provider = new RecordingProvider();
    seed(provider);

    const known = new Set(['db1']);
    app.use('/root/:dbid', (req, res, next) => {
      if (!known.has(req.params.dbid)) {
        res.status(404).json({ code: '404', description: 'Unknown database' });
        return;
      }
      res.locals.tenant = { id: req.params.dbid, label: `Tenant ${req.params.dbid}` };
      next();
    });

    const ogc = new OGCAPI(provider, app, {});
    app.use('/root/:dbid', ogc.getRouter());

    server = app.listen(0);
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => server?.close());

  it('exposes res.locals to the provider', async () => {
    provider.calls = [];
    await fetch(`${baseUrl}/root/db1/collections`);

    expect(provider.callsTo('getCollections')[0]?.locals.tenant).toEqual({
      id: 'db1',
      label: 'Tenant db1',
    });
  });

  it('never reaches the provider for a rejected tenant', async () => {
    provider.calls = [];
    const res = await fetch(`${baseUrl}/root/nope/collections`);

    expect(res.status).toBe(404);
    expect(provider.calls).toHaveLength(0);
  });
});
