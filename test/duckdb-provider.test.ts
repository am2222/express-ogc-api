import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { DuckDBProvider } from '../src/index.js';
import type { ProviderRequest } from '../src/index.js';
import type { DuckDBLocals } from '../src/index.js';

/**
 * Minimal stand-in for the request. The provider reads only `req.res.locals.db`
 * (and, for tenant-prefixed tables, `req.res.locals.key`) — exactly what
 * application middleware is expected to set.
 */
function fakeReq(
  db: DuckDBConnection,
  key?: string
): ProviderRequest<Record<string, string>, DuckDBLocals> {
  const res = { locals: key ? { db, key } : { db } };
  return { params: {}, query: {}, baseUrl: '', res } as unknown as ProviderRequest<
    Record<string, string>,
    DuckDBLocals
  >;
}

async function connect(instance: DuckDBInstance): Promise<DuckDBConnection> {
  const conn = await instance.connect();
  await conn.run('INSTALL spatial; LOAD spatial;');
  return conn;
}

describe('DuckDBProvider', () => {
  let instance: DuckDBInstance;
  let db: DuckDBConnection;
  let provider: DuckDBProvider;

  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
    db = await connect(instance);
    await db.run(`
      CREATE TABLE cities (
        id INTEGER PRIMARY KEY,
        name VARCHAR,
        population INTEGER,
        geometry GEOMETRY
      );
    `);
    await db.run(`
      INSERT INTO cities VALUES
        (1, 'London', 9002488, ST_Point(-0.1276, 51.5074)),
        (2, 'Paris',  2161000, ST_Point(2.3522, 48.8566)),
        (3, 'Tokyo', 13960000, ST_Point(139.6917, 35.6895));
    `);

    provider = new DuckDBProvider({ name: 'DuckDBProvider' });
  });

  afterAll(() => {
    db.disconnectSync();
  });

  it('discovers collections from the connection on the request', async () => {
    const collections = await provider.getCollections(fakeReq(db));

    expect(collections.map((c) => c.id)).toContain('cities');
  });

  it('reads features as GeoJSON, without the raw geometry column leaking into properties', async () => {
    const fc = await provider.getFeatures(fakeReq(db), 'cities', { limit: 10 });

    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(3);
    expect(fc.numberMatched).toBe(3);
    expect(fc.numberReturned).toBe(3);

    const london = fc.features.find((f) => f.properties.name === 'London');
    expect(london?.geometry).toEqual({ type: 'Point', coordinates: [-0.1276, 51.5074] });
    // The raw GEOMETRY column (WKB, a Buffer/Uint8Array) must not appear in
    // properties alongside the parsed GeoJSON geometry.
    expect(london?.properties.geometry).toBeUndefined();
  });

  it('respects limit and offset', async () => {
    const fc = await provider.getFeatures(fakeReq(db), 'cities', { limit: 1, offset: 1 });

    expect(fc.features).toHaveLength(1);
    expect(fc.numberReturned).toBe(1);
    expect(fc.numberMatched).toBe(3);
    // Not just "some one feature" — the second row in insertion order.
    expect(fc.features[0]?.properties.name).toBe('Paris');
  });

  it('filters by bbox (4-element)', async () => {
    const fc = await provider.getFeatures(fakeReq(db), 'cities', {
      limit: 10,
      // London (51.5074N) and Paris (48.8566N) both fall in this envelope;
      // Tokyo (35.6895N) does not. (miny=48, not 50 — see task-8A-report.md
      // for why: at miny=50 this bbox mathematically excludes Paris.)
      bbox: [-1, 48, 3, 52],
    });

    expect(fc.features.map((f) => f.properties.name).sort()).toEqual(['London', 'Paris']);
    expect(fc.numberMatched).toBe(2);
    expect(fc.numberReturned).toBe(2);
  });

  it('filters by bbox (6-element, with z bounds)', async () => {
    // Same 2D envelope as above, with arbitrary z bounds spliced in at
    // positions [2] and [5]: [minx, miny, minz, maxx, maxy, maxz].
    const fc = await provider.getFeatures(fakeReq(db), 'cities', {
      limit: 10,
      bbox: [-1, 48, -1000, 3, 52, 1000],
    });

    expect(fc.features.map((f) => f.properties.name).sort()).toEqual(['London', 'Paris']);
    expect(fc.numberMatched).toBe(2);
    expect(fc.numberReturned).toBe(2);
  });

  it('reads a single feature by id', async () => {
    const feature = await provider.getFeature(fakeReq(db), 'cities', '2');

    expect(feature?.properties.name).toBe('Paris');
    expect(feature?.properties.geometry).toBeUndefined();
  });

  it('returns null for a missing feature', async () => {
    expect(await provider.getFeature(fakeReq(db), 'cities', '999')).toBeNull();
  });

  it('derives a JSON schema from the table columns', async () => {
    const schema = await provider.getSchema(fakeReq(db), 'cities');
    const properties = schema.properties as Record<string, { type: string }>;

    expect(properties.name.type).toBe('string');
    expect(properties.population.type).toBe('integer');
  });

  it('creates, updates and deletes a feature', async () => {
    const created = await provider.createFeature(fakeReq(db), 'cities', {
      type: 'Feature',
      id: 4,
      geometry: null,
      properties: { id: 4, name: 'Berlin', population: 3645000 },
    });
    expect(created?.properties.name).toBe('Berlin');

    const updated = await provider.updateFeature(fakeReq(db), 'cities', '4', {
      feature: {
        type: 'Feature',
        id: 4,
        geometry: null,
        properties: { population: 3700000 },
      },
    });
    expect(Number(updated?.properties.population)).toBe(3700000);

    expect(await provider.deleteFeature(fakeReq(db), 'cities', '4')).toBe(true);
    expect(await provider.getFeature(fakeReq(db), 'cities', '4')).toBeNull();
  });

  it('creates a feature with geometry, using the table’s actual geometry column', async () => {
    const created = await provider.createFeature(fakeReq(db), 'cities', {
      type: 'Feature',
      id: 5,
      geometry: { type: 'Point', coordinates: [10.0, 20.0] },
      properties: { id: 5, name: 'Testville', population: 42 },
    });

    expect(created?.properties.name).toBe('Testville');
    expect(created?.geometry).toEqual({ type: 'Point', coordinates: [10, 20] });
    // The raw geometry column must not leak into properties here either.
    expect(created?.properties.geometry).toBeUndefined();

    expect(await provider.deleteFeature(fakeReq(db), 'cities', '5')).toBe(true);
  });

  it('reports false when deleting a feature that does not exist', async () => {
    expect(await provider.deleteFeature(fakeReq(db), 'cities', '999')).toBe(false);
  });

  it('replaceFeature stores a submitted geometry instead of silently dropping it', async () => {
    const created = await provider.createFeature(fakeReq(db), 'cities', {
      type: 'Feature',
      id: 6,
      geometry: { type: 'Point', coordinates: [10.0, 20.0] },
      properties: { id: 6, name: 'Geoville', population: 1 },
    });
    expect(created?.geometry).toEqual({ type: 'Point', coordinates: [10, 20] });

    const replaced = await provider.replaceFeature(fakeReq(db), 'cities', '6', {
      type: 'Feature',
      id: 6,
      geometry: { type: 'Point', coordinates: [30.0, 40.0] },
      properties: { name: 'Geoville', population: 1 },
    });
    expect(replaced?.geometry).toEqual({ type: 'Point', coordinates: [30, 40] });

    // Re-read independently to confirm the new geometry was actually persisted,
    // not just echoed back from the in-memory `feature` argument.
    const reread = await provider.getFeature(fakeReq(db), 'cities', '6');
    expect(reread?.geometry).toEqual({ type: 'Point', coordinates: [30, 40] });

    expect(await provider.deleteFeature(fakeReq(db), 'cities', '6')).toBe(true);
  });

  it('leaves the row untouched when updateFeature/replaceFeature get empty properties', async () => {
    const before = await provider.getFeature(fakeReq(db), 'cities', '1');

    const updated = await provider.updateFeature(fakeReq(db), 'cities', '1', {
      feature: { type: 'Feature', id: 1, geometry: null, properties: {} },
    });
    expect(updated?.properties).toEqual(before?.properties);

    const replaced = await provider.replaceFeature(fakeReq(db), 'cities', '1', {
      type: 'Feature',
      id: 1,
      geometry: null,
      properties: {},
    });
    expect(replaced?.properties).toEqual(before?.properties);
  });

  it('scopes discovery and reads to <key>_<collection> tables for a tenant', async () => {
    await db.run(`
      CREATE TABLE db1_cities (id INTEGER, name VARCHAR);
      INSERT INTO db1_cities VALUES (1, 'Tenant One City');
      CREATE TABLE db2_parks (id INTEGER, name VARCHAR);
      INSERT INTO db2_parks VALUES (1, 'Tenant Two Park');
    `);

    const tenant1 = (await provider.getCollections(fakeReq(db, 'db1'))).map((c) => c.id);
    expect(tenant1).toEqual(['cities']);
    expect(tenant1).not.toContain('parks');

    const tenant2 = (await provider.getCollections(fakeReq(db, 'db2'))).map((c) => c.id);
    expect(tenant2).toEqual(['parks']);
    expect(tenant2).not.toContain('cities');

    // Reads go through the same prefix: tenant1 can read its own 'cities' by
    // the bare collection id, and gets the tenant-scoped table, not the
    // top-level unprefixed 'cities' table used by the rest of this suite.
    const feature = await provider.getFeature(fakeReq(db, 'db1'), 'cities', '1');
    expect(feature?.properties.name).toBe('Tenant One City');

    // A tenant cannot reach the other tenant's table under its own collection id.
    expect(await provider.getCollection(fakeReq(db, 'db1'), 'parks')).toBeNull();
    expect(await provider.getCollection(fakeReq(db, 'db2'), 'cities')).toBeNull();
  });

  it('memoizes collection discovery for the life of one request', async () => {
    const spy = vi.spyOn(db, 'runAndReadAll');
    spy.mockClear();

    const req = fakeReq(db);
    await provider.getCollections(req);
    const callsAfterFirst = spy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Same request object again: must not re-run discovery.
    await provider.getCollections(req);
    expect(spy.mock.calls.length).toBe(callsAfterFirst);

    // A different request must not reuse the first request's memo.
    await provider.getCollections(fakeReq(db));
    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterFirst);

    spy.mockRestore();
  });

  it('getCollection does a targeted lookup, not a full-catalog scan', async () => {
    const spy = vi.spyOn(db, 'runAndReadAll');
    spy.mockClear();

    const collection = await provider.getCollection(fakeReq(db), 'cities');
    expect(collection?.id).toBe('cities');

    // A constant few queries — existence check, geometry-column lookup, extent
    // — never a per-table scan across the whole catalog (that's what
    // `getCollections` does; `getCollection` must not fall back to it).
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3);

    spy.mockRestore();
  });

  it('fails clearly when middleware did not supply a connection', async () => {
    const bare = { params: {}, query: {}, baseUrl: '', res: { locals: {} } } as unknown as ProviderRequest<
      Record<string, string>,
      DuckDBLocals
    >;

    await expect(provider.getCollections(bare)).rejects.toThrow(/res\.locals\.db/);
  });

  it('fails clearly, not with a raw TypeError, when req.res itself is missing', async () => {
    const noRes = { params: {}, query: {}, baseUrl: '' } as unknown as ProviderRequest<
      Record<string, string>,
      DuckDBLocals
    >;

    await expect(provider.getCollections(noRes)).rejects.toThrow(/res\.locals\.db/);
  });

  it('normalizes BIGINT columns so the feature round-trips and JSON.stringify does not throw (F1)', async () => {
    await db.run(`
      CREATE TABLE big_numbers (
        id BIGINT PRIMARY KEY,
        big_value BIGINT
      );
    `);
    // Comfortably above Number.MAX_SAFE_INTEGER (9007199254740991).
    const huge = 9223372036854775000n;
    await db.run(`INSERT INTO big_numbers VALUES (1, ${huge.toString()});`);

    const fc = await provider.getFeatures(fakeReq(db), 'big_numbers', { limit: 10 });
    const feature = fc.features[0];
    expect(feature).toBeDefined();
    expect(typeof feature?.id).not.toBe('bigint');
    expect(feature?.id).toBe(1);
    expect(typeof feature?.properties.big_value).not.toBe('bigint');
    // Outside the safe integer range: a decimal string, not a silently truncated number.
    expect(feature?.properties.big_value).toBe(huge.toString());
    expect(() => JSON.stringify(fc)).not.toThrow();

    const single = await provider.getFeature(fakeReq(db), 'big_numbers', '1');
    expect(typeof single?.properties.big_value).not.toBe('bigint');
    expect(single?.properties.big_value).toBe(huge.toString());
    expect(() => JSON.stringify(single)).not.toThrow();
  });

  it('throws when res.locals.key is an empty string, instead of failing open to full-catalog access (F2)', async () => {
    const req = {
      params: {},
      query: {},
      baseUrl: '',
      res: { locals: { db, key: '' } },
    } as unknown as ProviderRequest<Record<string, string>, DuckDBLocals>;

    await expect(provider.getCollections(req)).rejects.toThrow(/res\.locals\.key/);
  });

  it('throws when res.locals.key contains an underscore (F2)', async () => {
    const req = {
      params: {},
      query: {},
      baseUrl: '',
      res: { locals: { db, key: 'acme_eu' } },
    } as unknown as ProviderRequest<Record<string, string>, DuckDBLocals>;

    await expect(provider.getCollections(req)).rejects.toThrow(/res\.locals\.key/);
  });

  it('throws when res.locals.key contains other punctuation (F2)', async () => {
    const req = {
      params: {},
      query: {},
      baseUrl: '',
      res: { locals: { db, key: 'ac-me' } },
    } as unknown as ProviderRequest<Record<string, string>, DuckDBLocals>;

    await expect(provider.getCollections(req)).rejects.toThrow(/res\.locals\.key/);
  });

  it('treats an absent key as flat, single-tenant mode — still works, not an error (F2)', async () => {
    const collections = await provider.getCollections(fakeReq(db));
    expect(collections.map((c) => c.id)).toContain('cities');
  });
});
