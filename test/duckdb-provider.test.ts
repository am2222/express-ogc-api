import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { DuckDBProvider, OGCAPI, FeatureValidationError } from '../src/index.js';
import type { ProviderRequest } from '../src/index.js';
import type { DuckDBLocals } from '../src/index.js';

/**
 * Minimal stand-in for the request. `DuckDBProvider` itself is tenant-free:
 * it reads only `req.res.locals.db` — exactly what application middleware
 * is expected to set. (Tenant-prefix handling lives in the
 * `examples/prefixed-duckdb-provider.ts` subclass, covered separately in
 * `test/prefixed-duckdb-provider.test.ts`.)
 */
function fakeReq(db: DuckDBConnection): ProviderRequest<Record<string, string>, DuckDBLocals> {
  const res = { locals: { db } };
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

    // A table exercising constraints `getSchema` should now surface: a real
    // ENUM column, a NOT NULL column alongside a nullable one, a PRIMARY KEY
    // (so `x-ogc-role: 'id'` discovery has something unambiguous to find),
    // and — deliberately — a geometry column named `route`, not `geometry`,
    // so the `x-ogc-role: 'primary-geometry'` test actually exercises
    // discovery instead of a hardcoded name.
    await db.run(`
      CREATE TYPE surface_kind AS ENUM ('asphalt', 'gravel', 'dirt');
      CREATE TABLE roads (
        id INTEGER PRIMARY KEY,
        name VARCHAR NOT NULL,
        surface surface_kind,
        lane_count INTEGER,
        route GEOMETRY
      );
    `);
    await db.run(`
      INSERT INTO roads VALUES
        (1, 'Main St', 'asphalt', 2, ST_Point(0, 0));
    `);

    // A table with no geometry column at all, for the PUT regression case:
    // replacing a feature with a geometry against a table that can't accept
    // one used to 500 with a raw DuckDB Binder Error.
    await db.run(`
      CREATE TABLE attributes_only (id INTEGER PRIMARY KEY, label VARCHAR);
      INSERT INTO attributes_only VALUES (1, 'A');
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

  it('publishes enum, required, and role constraints from a real DuckDB schema', async () => {
    const schema = await provider.getSchema(fakeReq(db), 'roads');
    const properties = schema.properties as Record<
      string,
      { type: string; enum?: string[]; 'x-ogc-role'?: string }
    >;

    // ENUM: type + enum array, parsed out of `ENUM('asphalt', 'gravel', 'dirt')`.
    expect(properties.surface.type).toBe('string');
    expect(properties.surface.enum).toEqual(['asphalt', 'gravel', 'dirt']);

    // required: exactly the NOT NULL columns (id via PRIMARY KEY, name via
    // NOT NULL) — nullable columns (surface, lane_count, route) must be
    // absent, not just "not required due to omission".
    const required = schema.required as string[];
    expect(new Set(required)).toEqual(new Set(['id', 'name']));
    expect(required).not.toContain('surface');
    expect(required).not.toContain('lane_count');
    expect(required).not.toContain('route');

    // x-ogc-role: 'primary-geometry' on the *discovered* geometry column —
    // named `route` here, specifically not `geometry`, so this fails if the
    // implementation ever assumes the column name instead of discovering it.
    expect(properties.route['x-ogc-role']).toBe('primary-geometry');
    expect(properties.surface['x-ogc-role']).toBeUndefined();

    // x-ogc-role: 'id' on the unambiguous identifier column.
    expect(properties.id['x-ogc-role']).toBe('id');

    expect(schema.$schema).toBe('https://json-schema.org/draft/2019-09/schema');
    expect(schema.type).toBe('object');
  });

  it('advertises the Part 5 "Schemas" conformance class', async () => {
    expect(provider.conformanceClasses()).toContain(
      'http://www.opengis.net/spec/ogcapi-features-5/1.0/conf/schemas'
    );
  });

  it('orders properties with x-ogc-propertySeq matching declaration order, and gives each a title', async () => {
    const schema = await provider.getSchema(fakeReq(db), 'roads');
    const properties = schema.properties as Record<
      string,
      { title?: string; 'x-ogc-propertySeq'?: number }
    >;

    // `roads` was declared as: id, name, surface, lane_count, route (1-based
    // ordinal_position). Asserting the exact sequence — not just "some
    // number" — so this fails if the mapping is ever off by one or reversed.
    expect(properties.id['x-ogc-propertySeq']).toBe(1);
    expect(properties.name['x-ogc-propertySeq']).toBe(2);
    expect(properties.surface['x-ogc-propertySeq']).toBe(3);
    expect(properties.lane_count['x-ogc-propertySeq']).toBe(4);
    expect(properties.route['x-ogc-propertySeq']).toBe(5);

    // title: a simple, predictable derivation from the column name —
    // specifically checking the underscore-splitting case, not just that
    // *some* string is present.
    expect(properties.lane_count.title).toBe('Lane Count');
    expect(properties.id.title).toBe('Id');
    expect(properties.name.title).toBe('Name');
  });

  it('serves /schema and /queryables as application/schema+json over real HTTP', async () => {
    const app = express();
    app.use((_req, res, next) => {
      res.locals.db = db;
      next();
    });
    const ogc = new OGCAPI(provider, app, {});
    app.use(ogc.getRouter());

    const server = app.listen(0);
    const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;

    try {
      const schemaRes = await fetch(`${baseUrl}/collections/roads/schema`);
      expect(schemaRes.status).toBe(200);
      expect(schemaRes.headers.get('content-type')).toMatch(/^application\/schema\+json/);

      const queryablesRes = await fetch(`${baseUrl}/collections/roads/queryables`);
      expect(queryablesRes.status).toBe(200);
      expect(queryablesRes.headers.get('content-type')).toMatch(/^application\/schema\+json/);
    } finally {
      server.close();
    }
  });

  it('omits the enum rather than guessing when a data_type does not parse cleanly as ENUM(...)', async () => {
    // Exercise the parser directly through the class's private method the
    // same way the rest of this suite reaches other internals — a
    // malformed/foreign rendering must yield `undefined` (no `enum` key at
    // all), never a wrong or partial list.
    const parse = (provider as unknown as { parseEnumValues(t: string): string[] | undefined })
      .parseEnumValues.bind(provider);

    expect(parse("ENUM('a', 'b'")).toBeUndefined(); // unterminated
    expect(parse("ENUM(a, b)")).toBeUndefined(); // not quoted
    expect(parse("ENUM('a' 'b')")).toBeUndefined(); // missing comma
    expect(parse("VARCHAR")).toBeUndefined(); // not an enum at all
    // Values containing a quote and a comma round-trip correctly.
    expect(parse("ENUM('has''quote', 'has,comma')")).toEqual(["has'quote", 'has,comma']);
  });

  it('reports maxLength when DuckDB provides a character_maximum_length', async () => {
    // Verified against both the `@duckdb/node-api` binding and the `duckdb`
    // CLI (v1.5.1): DuckDB parses and discards a VARCHAR(n)/CHAR(n) length
    // at DDL time and `character_maximum_length` is always NULL in
    // `information_schema.columns` — there is no way to make a real DuckDB
    // table report a non-null value here. This test proves the mapping
    // logic is correct given a value DuckDB *could* supply, by intercepting
    // just the one query `getSchema` uses to read column metadata and
    // otherwise letting every other query (geometry-column discovery, id
    // discovery) run for real.
    const original = db.runAndReadAll.bind(db);
    const spy = vi.spyOn(db, 'runAndReadAll').mockImplementation(async (...args: any[]) => {
      const reader = await (original as any)(...args);
      const sql = args[0];
      if (typeof sql === 'string' && sql.includes('character_maximum_length') && sql.includes('is_nullable')) {
        const rows = reader.getRowObjectsJS().map((row: Record<string, unknown>) =>
          row['column_name'] === 'name' ? { ...row, character_maximum_length: 50 } : row
        );
        return { getRowObjectsJS: () => rows } as any;
      }
      return reader;
    });

    const schema = await provider.getSchema(fakeReq(db), 'roads');
    spy.mockRestore();

    const properties = schema.properties as Record<string, { maxLength?: number }>;
    expect(properties.name.maxLength).toBe(50);
    // A column DuckDB didn't report a length for must not get a guessed one.
    expect(properties.surface.maxLength).toBeUndefined();
  });

  it('maps a POINT-family DuckDB type to "object", not "integer" (mapDuckDBTypeToJSON substring bug)', async () => {
    await db.run(`CREATE TABLE point_types (id INTEGER PRIMARY KEY, location POINT_2D);`);

    const schema = await provider.getSchema(fakeReq(db), 'point_types');
    const properties = schema.properties as Record<string, { type: string }>;

    // 'POINT_2D'.includes('INT') is true, so before the fix this reported
    // 'integer'.
    expect(properties.location.type).toBe('object');
  });

  it('rejects an invalid enum value with a translated error, not the raw DuckDB one', async () => {
    let caught: unknown;
    try {
      await provider.createFeature(fakeReq(db), 'roads', {
        type: 'Feature',
        id: 900,
        geometry: null,
        properties: { id: 900, name: 'Bad Road', surface: 'concrete', lane_count: 1 },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FeatureValidationError);
    const err = caught as FeatureValidationError;
    expect(err.status).toBe(400);
    expect(err.property).toBe('surface');
    // The whole point: DuckDB's own wording (the enum's physical storage
    // type) must not reach the message.
    expect(err.message).not.toContain('UINT8');
    expect(err.message).not.toContain('Conversion Error');
    expect(err.message).toContain('surface');
    // The original DuckDB error is preserved for server-side logs.
    expect(String((err.cause as Error)?.message)).toContain('UINT8');
  });

  it('maps a NOT NULL violation to a translated 400 naming the property', async () => {
    let caught: unknown;
    try {
      await provider.createFeature(fakeReq(db), 'roads', {
        type: 'Feature',
        id: 901,
        geometry: null,
        // `name` is NOT NULL and omitted here.
        properties: { id: 901, surface: 'asphalt' },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FeatureValidationError);
    const err = caught as FeatureValidationError;
    expect(err.status).toBe(400);
    expect(err.property).toBe('name');
    expect(err.message).not.toContain('Constraint Error');
  });

  it('maps a PUT with a geometry against a table with no geometry column to 400, not 500 (regression)', async () => {
    let caught: unknown;
    try {
      await provider.replaceFeature(fakeReq(db), 'attributes_only', '1', {
        type: 'Feature',
        id: 1,
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: { label: 'B' },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FeatureValidationError);
    const err = caught as FeatureValidationError;
    expect(err.status).toBe(400);
    expect(err.message).not.toContain('Binder Error');
    expect(err.message).not.toContain('not found in table');
  });

  it('rejects an invalid enum value as a 400 over real HTTP, not a 500 mentioning UINT8', async () => {
    const app = express();
    app.use((_req, res, next) => {
      res.locals.db = db;
      next();
    });
    const ogc = new OGCAPI(provider, app, {});
    app.use(ogc.getRouter());

    const server = app.listen(0);
    const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;

    try {
      const res = await fetch(`${baseUrl}/collections/roads/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/geo+json' },
        body: JSON.stringify({
          type: 'Feature',
          geometry: null,
          properties: { id: 902, name: 'HTTP Bad Road', surface: 'concrete', lane_count: 1 },
        }),
      });
      const body = (await res.json()) as { code: string; description: string };

      expect(res.status).toBe(400);
      expect(JSON.stringify(body)).not.toContain('UINT8');
      expect(body.description).toContain('surface');
    } finally {
      server.close();
    }
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

  it('lists every table in the schema as a collection, unprefixed, with no filtering', async () => {
    await db.run(`
      CREATE TABLE db1_cities (id INTEGER, name VARCHAR);
      INSERT INTO db1_cities VALUES (1, 'Tenant One City');
      CREATE TABLE db2_parks (id INTEGER, name VARCHAR);
      INSERT INTO db2_parks VALUES (1, 'Tenant Two Park');
    `);

    // The tenant-free library class does no prefix filtering at all: table
    // names *are* collection ids, verbatim, whatever they happen to be
    // named. (Prefix-based scoping/hiding is what the
    // `examples/prefixed-duckdb-provider.ts` subclass adds back in — see
    // `test/prefixed-duckdb-provider.test.ts`.)
    const ids = (await provider.getCollections(fakeReq(db))).map((c) => c.id);
    expect(ids).toContain('cities');
    expect(ids).toContain('db1_cities');
    expect(ids).toContain('db2_parks');

    // Reads use the collection id as the table name directly, no mapping.
    const feature = await provider.getFeature(fakeReq(db), 'db1_cities', '1');
    expect(feature?.properties.name).toBe('Tenant One City');

    expect(await provider.getCollection(fakeReq(db), 'db2_parks')).not.toBeNull();
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

  // Tenant-key validation (F2) now lives in the `PrefixedDuckDBProvider`
  // subclass, not in the tenant-free library class — see
  // `test/prefixed-duckdb-provider.test.ts`.
});
