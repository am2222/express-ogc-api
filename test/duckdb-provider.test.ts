import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { DuckDBProvider, OGCAPI, FeatureValidationError, Cql2Error, Cql2ToSql } from '../src/index.js';
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

    // A table exercising every `format`/`description`/binary-serialization
    // addition: `DATE`, `TIMESTAMP`, `TIMESTAMP WITH TIME ZONE` (deliberately
    // alongside plain `TIMESTAMP`, so a substring-ordering bug that
    // misclassifies one as the other has something to fail against), `TIME`
    // (one row with a whole-second value, one with a fractional one), `UUID`,
    // and `BLOB`. `label` carries a column comment; `created_date` does not,
    // so the "no comment -> no description key" case has something to check
    // against in the same table. `geom` is single-type (POINT only), for the
    // `geometry-point` format case.
    await db.run(`
      CREATE TABLE richly_typed (
        id INTEGER PRIMARY KEY,
        label VARCHAR,
        created_date DATE,
        created_at TIMESTAMP,
        created_at_tz TIMESTAMP WITH TIME ZONE,
        opens_at TIME,
        external_id UUID,
        payload BLOB,
        geom GEOMETRY
      );
      COMMENT ON COLUMN richly_typed.label IS 'A human-friendly label';

      INSERT INTO richly_typed VALUES (
        1, 'Alpha',
        DATE '2024-01-15',
        TIMESTAMP '2024-01-15 10:30:00',
        TIMESTAMP WITH TIME ZONE '2024-01-15 10:30:00+00',
        TIME '03:04:05',
        UUID '123e4567-e89b-12d3-a456-426614174000',
        'hi'::BLOB,
        ST_Point(0, 0)
      );
      INSERT INTO richly_typed VALUES (
        2, 'Beta',
        DATE '2024-02-20',
        TIMESTAMP '2024-02-20 08:00:00',
        TIMESTAMP WITH TIME ZONE '2024-02-20 08:00:00+00',
        TIME '12:00:00.25',
        UUID '223e4567-e89b-12d3-a456-426614174001',
        'AB'::BLOB,
        ST_Point(1, 1)
      );
    `);

    // Mixed geometry types (POINT and LINESTRING both present) — the
    // `geometry-any` fallback, distinct from the "no rows" and "all null"
    // cases below.
    await db.run(`
      CREATE TABLE mixed_geometry (id INTEGER PRIMARY KEY, geom GEOMETRY);
      INSERT INTO mixed_geometry VALUES
        (1, ST_Point(0, 0)),
        (2, ST_GeomFromText('LINESTRING(0 0, 1 1)'));
    `);

    // Every geometry value NULL — also `geometry-any`, distinct from "mixed".
    await db.run(`
      CREATE TABLE all_null_geometry (id INTEGER PRIMARY KEY, geom GEOMETRY);
      INSERT INTO all_null_geometry VALUES (1, NULL), (2, NULL);
    `);

    // For the CQL2 `filter` parameterisation test: a name containing a
    // literal single quote. `O''Brien` is how CQL2-text escapes it; if the
    // literal were ever concatenated into the SQL instead of bound, this
    // would either break the query outright or (worse) silently match the
    // wrong rows.
    await db.run(`
      CREATE TABLE people (id INTEGER PRIMARY KEY, name VARCHAR);
      INSERT INTO people VALUES (1, 'O''Brien'), (2, 'Smith');
    `);

    // Fixture for the QGIS "duplicate geometry column" regression
    // (`stripDiscoveredGeometryProperty`): shaped like the real table QGIS's
    // captured request body was sent against — a `geometry` column plus
    // ordinary attribute columns, and existing ids 1-3 so a client-supplied
    // colliding id has something real to conflict with.
    await db.run(`
      CREATE TABLE qgis_polygons (
        id INTEGER PRIMARY KEY,
        name VARCHAR,
        zone_type VARCHAR,
        geometry GEOMETRY
      );
      INSERT INTO qgis_polygons VALUES
        (1, 'Zone A', 'residential', ST_GeomFromText('POLYGON((0 0, 0 1, 1 1, 1 0, 0 0))')),
        (2, 'Zone B', 'commercial', ST_GeomFromText('POLYGON((2 0, 2 1, 3 1, 3 0, 2 0))')),
        (3, 'Zone C', 'industrial', ST_GeomFromText('POLYGON((4 0, 4 1, 5 1, 5 0, 4 0))'));
    `);

    // Same shape, but the geometry column is named `geom`, not `geometry` —
    // proves the exclusion keys off the *discovered* column name, not the
    // literal string `'geometry'`.
    await db.run(`
      CREATE TABLE qgis_polygons_geom_named (
        id INTEGER PRIMARY KEY,
        name VARCHAR,
        geom GEOMETRY
      );
      INSERT INTO qgis_polygons_geom_named VALUES
        (1, 'Existing', ST_GeomFromText('POLYGON((0 0, 0 1, 1 1, 1 0, 0 0))'));
    `);

    // Same shape as `qgis_polygons`, but the id column is backed by a
    // sequence default (`examples/build-demo-duckdb.ts` now gives every demo
    // table exactly this shape). Seeded rows still supply an explicit id —
    // an explicit value in an INSERT beats a column DEFAULT, same as any
    // other write — so ids 1-3 exist here too, and the sequence starts at
    // 100 so a generated id never collides with them.
    await db.run(`
      CREATE SEQUENCE seq_polygons_id_seq START 100;
      CREATE TABLE seq_polygons (
        id INTEGER PRIMARY KEY DEFAULT nextval('seq_polygons_id_seq'),
        name VARCHAR,
        zone_type VARCHAR,
        geometry GEOMETRY
      );
      INSERT INTO seq_polygons (id, name, zone_type, geometry) VALUES
        (1, 'Zone A', 'residential', ST_GeomFromText('POLYGON((0 0, 0 1, 1 1, 1 0, 0 0))')),
        (2, 'Zone B', 'commercial', ST_GeomFromText('POLYGON((2 0, 2 1, 3 1, 3 0, 2 0))')),
        (3, 'Zone C', 'industrial', ST_GeomFromText('POLYGON((4 0, 4 1, 5 1, 5 0, 4 0))'));
    `);

    // A table whose *non*-identifier column also has a database default —
    // isolates the `readOnly` assertion to "this is the id column with a
    // default", not "any column with a default". `id` here has no default
    // of its own (contrast with `seq_polygons` above), so a client is still
    // required to supply it, while `status` defaults but is an ordinary
    // writable attribute.
    await db.run(`
      CREATE TABLE defaulted_status (
        id INTEGER PRIMARY KEY,
        status VARCHAR DEFAULT 'active'
      );
      INSERT INTO defaulted_status (id, status) VALUES (1, 'active');
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

  it('serves TIME/BLOB/DATE serialization and schema format/description/contentEncoding over real HTTP', async () => {
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
      const schemaRes = await fetch(`${baseUrl}/collections/richly_typed/schema`);
      const schema = (await schemaRes.json()) as {
        properties: Record<
          string,
          { type?: string; format?: string; description?: string; contentEncoding?: string }
        >;
      };
      expect(schema.properties.opens_at.format).toBe('time');
      expect(schema.properties.created_date.format).toBe('date');
      expect(schema.properties.created_at_tz.format).toBe('date-time');
      expect(schema.properties.label.description).toBe('A human-friendly label');
      expect(schema.properties.payload.contentEncoding).toBe('base64');
      expect(schema.properties.geom.format).toBe('geometry-point');

      const itemsRes = await fetch(`${baseUrl}/collections/richly_typed/items`);
      expect(itemsRes.status).toBe(200);
      const body = (await itemsRes.text());
      // Serialized JSON, over the wire, actually parses — this is what would
      // throw if a raw Uint8Array/bigint ever reached res.json() unconverted.
      const fc = JSON.parse(body) as { features: Array<{ properties: Record<string, unknown> }> };
      const alpha = fc.features.find((f) => f.properties.label === 'Alpha');
      expect(alpha?.properties.opens_at).toBe('03:04:05');
      expect(alpha?.properties.payload).toBe(Buffer.from('hi').toString('base64'));
      // A bare date, per `format: 'date'` — NOT a full ISO instant
      // ('2024-01-15T00:00:00.000Z'), which is what this used to (wrongly)
      // serialize as before the DATE-vs-TIMESTAMP fix.
      expect(alpha?.properties.created_date).toBe('2024-01-15');
      expect(alpha?.properties.created_at_tz).toBe('2024-01-15T10:30:00.000Z');
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

  it('maps DATE/TIMESTAMP/TIMESTAMP WITH TIME ZONE/TIME/UUID to their JSON Schema formats, without the TIMESTAMP/TIME substring collision', async () => {
    const schema = await provider.getSchema(fakeReq(db), 'richly_typed');
    const properties = schema.properties as Record<string, { type?: string; format?: string }>;

    expect(properties.created_date).toMatchObject({ type: 'string', format: 'date' });
    // Both TIMESTAMP variants map to 'date-time' — in particular
    // `created_at_tz` (TIMESTAMP WITH TIME ZONE) must NOT come out as
    // 'time' just because its data_type string contains "TIME ZONE".
    expect(properties.created_at).toMatchObject({ type: 'string', format: 'date-time' });
    expect(properties.created_at_tz).toMatchObject({ type: 'string', format: 'date-time' });
    // And the reverse must also hold: a genuine TIME column must not be
    // swept into 'date-time' by an overly broad TIMESTAMP check.
    expect(properties.opens_at).toMatchObject({ type: 'string', format: 'time' });
    expect(properties.external_id).toMatchObject({ type: 'string', format: 'uuid' });
  });

  it('emits contentEncoding: base64 for a BLOB column in the schema', async () => {
    const schema = await provider.getSchema(fakeReq(db), 'richly_typed');
    const properties = schema.properties as Record<string, { type?: string; contentEncoding?: string }>;

    expect(properties.payload.type).toBe('string');
    expect(properties.payload.contentEncoding).toBe('base64');
  });

  it('emits description from a column comment, and omits it entirely when there is none', async () => {
    const schema = await provider.getSchema(fakeReq(db), 'richly_typed');
    const properties = schema.properties as Record<string, { description?: string }>;

    expect(properties.label.description).toBe('A human-friendly label');
    // No COMMENT ON COLUMN was set for created_date — the key must be
    // entirely absent, not present-and-null or present-and-empty.
    expect(properties.created_date.description).toBeUndefined();
    expect('description' in properties.created_date).toBe(false);
  });

  it('reports a specific geometry-<type> format for a single-type geometry column', async () => {
    const schema = await provider.getSchema(fakeReq(db), 'richly_typed');
    const properties = schema.properties as Record<string, { format?: string }>;

    // richly_typed's geom column holds POINT values only.
    expect(properties.geom.format).toBe('geometry-point');
  });

  it('falls back to geometry-any when a geometry column mixes more than one type', async () => {
    const schema = await provider.getSchema(fakeReq(db), 'mixed_geometry');
    const properties = schema.properties as Record<string, { format?: string }>;

    expect(properties.geom.format).toBe('geometry-any');
  });

  it('falls back to geometry-any when every value in a geometry column is null', async () => {
    const schema = await provider.getSchema(fakeReq(db), 'all_null_geometry');
    const properties = schema.properties as Record<string, { format?: string }>;

    expect(properties.geom.format).toBe('geometry-any');
  });

  it('serializes a TIME column as an ISO clock string, not a raw bigint of microseconds', async () => {
    const fc = await provider.getFeatures(fakeReq(db), 'richly_typed', { limit: 10 });

    const alpha = fc.features.find((f) => f.properties.label === 'Alpha');
    // Whole-second TIME value: no fractional-seconds suffix.
    expect(alpha?.properties.opens_at).toBe('03:04:05');
    expect(typeof alpha?.properties.opens_at).toBe('string');

    const beta = fc.features.find((f) => f.properties.label === 'Beta');
    // Fractional TIME value: '.25' must survive, not be dropped or rounded.
    expect(beta?.properties.opens_at).toBe('12:00:00.25');

    // Also verified via the single-feature read path, not just getFeatures.
    const single = await provider.getFeature(fakeReq(db), 'richly_typed', '1');
    expect(single?.properties.opens_at).toBe('03:04:05');

    expect(() => JSON.stringify(fc)).not.toThrow();
  });

  it('serializes a DATE column as a bare YYYY-MM-DD string, using UTC components not local ones', async () => {
    const originalTZ = process.env.TZ;
    try {
      // DuckDB's DATE value is a `Date` at UTC midnight, independent of the
      // process's local timezone — but an implementation that formatted it
      // with *local* getters (getFullYear/getMonth/getDate) instead of the
      // UTC ones would read the previous local day on any machine west of
      // UTC, silently shifting the value back by one. Forcing a UTC-negative
      // zone here means that exact regression can't hide behind whatever
      // timezone happens to run the test — a naive local-getter
      // implementation reads 2024-01-15T00:00:00Z as 2024-01-14 in
      // America/Los_Angeles (UTC-8).
      process.env.TZ = 'America/Los_Angeles';

      const fc = await provider.getFeatures(fakeReq(db), 'richly_typed', { limit: 10 });
      const alpha = fc.features.find((f) => f.properties.label === 'Alpha');
      expect(alpha?.properties.created_date).toBe('2024-01-15');
      expect(typeof alpha?.properties.created_date).toBe('string');

      const beta = fc.features.find((f) => f.properties.label === 'Beta');
      expect(beta?.properties.created_date).toBe('2024-02-20');

      // Also verified via the single-feature read path, not just getFeatures.
      const single = await provider.getFeature(fakeReq(db), 'richly_typed', '1');
      expect(single?.properties.created_date).toBe('2024-01-15');
    } finally {
      process.env.TZ = originalTZ;
    }
  });

  it('leaves TIMESTAMP/TIMESTAMP WITH TIME ZONE as a full ISO instant — only DATE gets the bare YYYY-MM-DD treatment', async () => {
    const fc = await provider.getFeatures(fakeReq(db), 'richly_typed', { limit: 10 });

    // `rowToFeature`/`normalizeValue` don't touch TIMESTAMP/TIMESTAMPTZ at
    // all — they pass the raw `Date` straight through, same as before this
    // task — and it's `JSON.stringify` (via `res.json()` in real use, and
    // explicitly here) that turns a `Date` into a full ISO instant through
    // its own `toJSON()`. Round-tripping through JSON is what actually
    // exercises that, rather than asserting on the still-a-`Date` value.
    const parsed = JSON.parse(JSON.stringify(fc)) as { features: Array<{ properties: Record<string, unknown> }> };
    const alpha = parsed.features.find((f) => f.properties.label === 'Alpha');

    // Unchanged, pre-existing (and correct) behaviour: a TIMESTAMP/TIMESTAMPTZ
    // value must still serialize as a full ISO instant, matching the
    // `format: 'date-time'` the schema declares for these columns — the DATE
    // fix must not have been over-applied to them.
    expect(alpha?.properties.created_at).toBe('2024-01-15T10:30:00.000Z');
    expect(alpha?.properties.created_at_tz).toBe('2024-01-15T10:30:00.000Z');
  });

  it('serializes a BLOB column as a base64 string, not {"0":...} byte-index JSON', async () => {
    const fc = await provider.getFeatures(fakeReq(db), 'richly_typed', { limit: 10 });

    const alpha = fc.features.find((f) => f.properties.label === 'Alpha');
    expect(alpha?.properties.payload).toBe(Buffer.from('hi').toString('base64'));
    expect(typeof alpha?.properties.payload).toBe('string');

    const beta = fc.features.find((f) => f.properties.label === 'Beta');
    expect(beta?.properties.payload).toBe(Buffer.from('AB').toString('base64'));

    // Not the byte-indexed-object shape a raw Uint8Array would produce.
    expect(JSON.stringify(fc)).not.toContain('"0":');
  });

  it('does not misclassify a genuine BIGINT column as TIME (disambiguation is column-type-driven, not value-shaped)', async () => {
    // This table's BIGINT column holds a value that, read as TIME
    // microseconds, would decode to a bogus but plausible-looking clock
    // string ('12:30:45'). It must still come out as a plain number, per the
    // existing BIGINT normalisation (F1) — proving TIME formatting is
    // applied only to columns actually declared TIME, not to any bigint
    // value that happens to arrive.
    await db.run(`
      CREATE TABLE big_not_time (id INTEGER PRIMARY KEY, big_value BIGINT);
      INSERT INTO big_not_time VALUES (1, 45045000000);
    `);

    const fc = await provider.getFeatures(fakeReq(db), 'big_not_time', { limit: 10 });
    expect(fc.features[0]?.properties.big_value).toBe(45045000000);
    expect(fc.features[0]?.properties.big_value).not.toBe('12:30:45');
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

  describe('CQL2 filter (Part 3)', () => {
    it('actually filters — features are the expected subset AND numberMatched reflects it', async () => {
      // Threshold chosen so it is neither "everyone" nor "no one": London
      // (9,002,488) and Tokyo (13,960,000) qualify, Paris (2,161,000) does
      // not. An assertion on `features.length` alone would not catch a
      // provider that ignored the filter and returned all three with a
      // `numberMatched` of 3 — this is the exact shape of the bug being
      // fixed, so both are asserted.
      const fc = await provider.getFeatures(fakeReq(db), 'cities', {
        limit: 10,
        filter: 'population > 3000000',
      });

      expect(fc.features.map((f) => f.properties.name).sort()).toEqual(['London', 'Tokyo']);
      expect(fc.numberMatched).toBe(2);
      expect(fc.numberReturned).toBe(2);
    });

    it('combines a filter with a bbox — both predicates apply', async () => {
      // bbox covers London and Paris only (see the bbox test above); the
      // filter further narrows to population > 3000000, which excludes
      // Paris. Only the intersection — London — must come back.
      const fc = await provider.getFeatures(fakeReq(db), 'cities', {
        limit: 10,
        bbox: [-1, 48, 3, 52],
        filter: 'population > 3000000',
      });

      expect(fc.features.map((f) => f.properties.name)).toEqual(['London']);
      expect(fc.numberMatched).toBe(1);
      expect(fc.numberReturned).toBe(1);
    });

    it('binds a literal containing a single quote as a parameter, not by string interpolation', async () => {
      // CQL2-text escapes an embedded quote by doubling it. If the
      // translated value were ever concatenated into the SQL text instead of
      // bound as a `?` parameter, this would either break the query or match
      // the wrong row.
      const fc = await provider.getFeatures(fakeReq(db), 'people', {
        limit: 10,
        filter: "name = 'O''Brien'",
      });

      expect(fc.features.map((f) => f.properties.name)).toEqual(['O\'Brien']);
      expect(fc.numberMatched).toBe(1);

      // Record the generated SQL and bound params for one representative
      // filter, so the parameterisation is on the record.
      const translator = new Cql2ToSql({ allowedProperties: ['id', 'name'] });
      const { sql, params } = translator.toSql("name = 'O''Brien'");
      expect(sql).toBe('"name" = ?');
      expect(params).toEqual(["O'Brien"]);
    });

    it('rejects an unknown property as UNKNOWN_PROPERTY, naming it — not a raw DuckDB Binder Error', async () => {
      let caught: unknown;
      try {
        await provider.getFeatures(fakeReq(db), 'cities', { limit: 10, filter: 'secret = 1' });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Cql2Error);
      const err = caught as Cql2Error;
      expect(err.code).toBe('UNKNOWN_PROPERTY');
      expect(err.detail).toBe('secret');
    });

    it('rejects a malformed filter as PARSE_ERROR', async () => {
      let caught: unknown;
      try {
        await provider.getFeatures(fakeReq(db), 'cities', { limit: 10, filter: "name = 'unterminated" });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Cql2Error);
      expect((caught as Cql2Error).code).toBe('PARSE_ERROR');
    });

    it('rejects a valid-but-unsupported CQL2 construct as UNSUPPORTED_OP', async () => {
      // `UPPER(...)` is genuine CQL2 (cql2-rs parses it, and can even
      // translate it to DuckSQL) but is not in this package's `SUPPORTED_OPS`
      // allowlist — see the report for why this is flagged as a gap rather
      // than patched here (src/cql2/ is owned by another agent).
      let caught: unknown;
      try {
        await provider.getFeatures(fakeReq(db), 'cities', {
          limit: 10,
          filter: "UPPER(name) = 'LONDON'",
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Cql2Error);
      expect((caught as Cql2Error).code).toBe('UNSUPPORTED_OP');
    });

    it('geometry column is an allowed filter property (spatial predicates can name it)', async () => {
      // `roads`'s geometry column is `route`, not `geometry` — proving this
      // is discovery-driven, not a hardcoded allowance for a literal
      // "geometry" name.
      const fc = await provider.getFeatures(fakeReq(db), 'roads', {
        limit: 10,
        filter: 'S_INTERSECTS(route, POINT(0 0))',
      });

      expect(fc.features.map((f) => f.properties.name)).toEqual(['Main St']);
      expect(fc.numberMatched).toBe(1);
    });

    describe('over real HTTP', () => {
      function startServer(): { baseUrl: string; close: () => void } {
        const app = express();
        app.use((_req, res, next) => {
          res.locals.db = db;
          next();
        });
        const ogc = new OGCAPI(provider, app, {});
        app.use(ogc.getRouter());
        const server = app.listen(0);
        const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
        return { baseUrl, close: () => server.close() };
      }

      it('an unknown property in filter is a 400 over HTTP, with the property name in the body', async () => {
        const { baseUrl, close } = startServer();
        try {
          const res = await fetch(`${baseUrl}/collections/cities/items?filter=${encodeURIComponent('secret = 1')}`);
          const body = (await res.json()) as { code: string; description: string };

          expect(res.status).toBe(400);
          expect(body.description).toContain('secret');
          expect(body.description).toContain('UNKNOWN_PROPERTY');
        } finally {
          close();
        }
      });

      it('a malformed filter is a 400 over HTTP', async () => {
        const { baseUrl, close } = startServer();
        try {
          const res = await fetch(
            `${baseUrl}/collections/cities/items?filter=${encodeURIComponent("name = 'unterminated")}`
          );
          const body = (await res.json()) as { code: string; description: string };

          expect(res.status).toBe(400);
          expect(body.description).toContain('PARSE_ERROR');
        } finally {
          close();
        }
      });

      it('a filter cql2-rs parses leniently into a non-boolean fragment is a 400, not a 500 leaking SQL', async () => {
        // `cql2-rs` parses `name ===` leniently, discarding the malformed
        // `==` tail, and returns a bare property reference rather than
        // throwing — so `Cql2ToSql` never raises a `Cql2Error` here, and the
        // Cql2Error -> 400 mapping in items-curd.ts never fires. DuckDB then
        // rejects the resulting `WHERE ("name")` at runtime because a
        // VARCHAR column isn't a boolean expression. Without the provider's
        // defensive net, this would 500 with the generated SQL and the
        // physical table name in the body.
        const { baseUrl, close } = startServer();
        try {
          const res = await fetch(`${baseUrl}/collections/cities/items?filter=${encodeURIComponent('name ===')}`);
          const body = await res.text();

          expect(res.status).toBe(400);
          expect(body).not.toContain('SELECT');
          expect(body).not.toContain('cities');
          expect(body).toContain('name ===');

          const parsed = JSON.parse(body) as { code: string; description: string };
          expect(parsed.description).toContain('name ===');
        } finally {
          close();
        }
      });

      it('a second, differently-shaped lenient-parse filter is also a 400, not a 500', async () => {
        // A different malformed expression (`EXISTS` used as a bare suffix,
        // rather than `===`) that `cql2-rs` also parses down to a bare,
        // non-boolean property reference — proving the defensive net isn't
        // narrowly matching just the one reported string.
        const { baseUrl, close } = startServer();
        try {
          const res = await fetch(`${baseUrl}/collections/cities/items?filter=${encodeURIComponent('name EXISTS')}`);
          const body = await res.text();

          expect(res.status).toBe(400);
          expect(body).not.toContain('SELECT');
          expect(body).not.toContain('cities');
        } finally {
          close();
        }
      });

      it('an unfiltered request that fails for a genuine server reason still 500s (guard against over-broad catching)', async () => {
        // No `filter` at all — a missing-collection Catalog Error here must
        // NOT be caught by the same defensive net as the filter-shaped
        // errors above. If the net were scoped on the error's *text*
        // (matching "Conversion Error"/"Binder Error" generically) rather
        // than on "a filter was actually applied", this would wrongly turn
        // into a 400 and nothing would catch that regression.
        const { baseUrl, close } = startServer();
        try {
          const res = await fetch(`${baseUrl}/collections/does_not_exist_at_all/items`);
          expect(res.status).toBe(500);
        } finally {
          close();
        }
      });

      it('a valid-but-unsupported CQL2 construct is a 400 over HTTP', async () => {
        const { baseUrl, close } = startServer();
        try {
          const res = await fetch(
            `${baseUrl}/collections/cities/items?filter=${encodeURIComponent("UPPER(name) = 'LONDON'")}`
          );
          const body = (await res.json()) as { code: string; description: string };

          expect(res.status).toBe(400);
          expect(body.description).toContain('UNSUPPORTED_OP');
        } finally {
          close();
        }
      });

      it('pagination under a filter: limit/offset produce correct numberMatched and next/prev links', async () => {
        const { baseUrl, close } = startServer();
        const filter = encodeURIComponent('population > 3000000');
        try {
          // Page 1: London and Tokyo both match; limit 1 offset 0 -> London,
          // with a `next` link (since 0 + 1 < 2) and no `prev` link.
          const page1 = await fetch(`${baseUrl}/collections/cities/items?filter=${filter}&limit=1&offset=0`);
          const body1 = (await page1.json()) as {
            features: Array<{ properties: { name: string } }>;
            numberMatched: number;
            links: Array<{ rel: string; href: string }>;
          };
          expect(page1.status).toBe(200);
          expect(body1.numberMatched).toBe(2);
          expect(body1.features.map((f) => f.properties.name)).toEqual(['London']);
          const next = body1.links.find((l) => l.rel === 'next');
          expect(next).toBeDefined();
          expect(next?.href).toContain('offset=1');
          expect(body1.links.find((l) => l.rel === 'prev')).toBeUndefined();

          // Page 2: offset 1 -> Tokyo, with a `prev` link back to offset 0
          // and no `next` link (since 1 + 1 is not < 2).
          const page2 = await fetch(`${baseUrl}/collections/cities/items?filter=${filter}&limit=1&offset=1`);
          const body2 = (await page2.json()) as {
            features: Array<{ properties: { name: string } }>;
            numberMatched: number;
            links: Array<{ rel: string; href: string }>;
          };
          expect(page2.status).toBe(200);
          expect(body2.numberMatched).toBe(2);
          expect(body2.features.map((f) => f.properties.name)).toEqual(['Tokyo']);
          expect(body2.links.find((l) => l.rel === 'next')).toBeUndefined();
          const prev = body2.links.find((l) => l.rel === 'prev');
          expect(prev).toBeDefined();
          expect(prev?.href).toContain('offset=0');
        } finally {
          close();
        }
      });
    });
  });

  describe('QGIS write regression: duplicate geometry property (Part 4)', () => {
    // The exact body shape a real QGIS client sent (captured from the
    // request log): a top-level `geometry` alongside a `properties` map
    // that *also* carries a `geometry` key (typically `null`, since QGIS
    // read it from the schema as an ordinary attribute field). Before the
    // fix, `createFeature`/`replaceFeature`/`updateFeature` built their
    // column list straight from `Object.keys(feature.properties)`, which
    // included this artifact, and then appended the discovered geometry
    // column a second time for the real top-level geometry — DuckDB
    // rejects an INSERT with a duplicate column name outright.
    function qgisShapedBody(overrides: {
      id: number;
      geometry: unknown;
      properties: Record<string, unknown>;
    }) {
      return {
        type: 'Feature',
        geometry: overrides.geometry,
        properties: { id: overrides.id, ...overrides.properties },
      };
    }

    function startServer(): { baseUrl: string; close: () => void } {
      const app = express();
      app.use((_req, res, next) => {
        res.locals.db = db;
        next();
      });
      const ogc = new OGCAPI(provider, app, {});
      app.use(ogc.getRouter());
      const server = app.listen(0);
      const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
      return { baseUrl, close: () => server.close() };
    }

    it('POST: a QGIS-shaped body (properties.geometry alongside top-level geometry) creates the feature with the top-level geometry, not clobbered', async () => {
      const newGeometry = { type: 'Polygon', coordinates: [[[10, 10], [10, 11], [11, 11], [11, 10], [10, 10]]] };

      const created = await provider.createFeature(
        fakeReq(db),
        'qgis_polygons',
        qgisShapedBody({
          id: 50,
          geometry: newGeometry,
          properties: { name: 'New Zone', zone_type: 'test', geometry: null },
        }) as any
      );

      expect(created).not.toBeNull();
      expect(created?.properties.name).toBe('New Zone');
      // The property artifact must not leak back out either.
      expect(created?.properties.geometry).toBeUndefined();
      // The top-level geometry — not the `null` sitting in `properties` — is
      // what got stored.
      expect(created?.geometry).toEqual(newGeometry);

      // Re-read independently: confirms it was actually persisted this way,
      // not just echoed back from the in-memory argument.
      const reread = await provider.getFeature(fakeReq(db), 'qgis_polygons', '50');
      expect(reread?.geometry).toEqual(newGeometry);
      expect(reread?.properties.name).toBe('New Zone');

      expect(await provider.deleteFeature(fakeReq(db), 'qgis_polygons', '50')).toBe(true);
    });

    it('PUT: the same QGIS-shaped body replaces the feature with the top-level geometry, not clobbered', async () => {
      const newGeometry = { type: 'Polygon', coordinates: [[[20, 20], [20, 21], [21, 21], [21, 20], [20, 20]]] };

      const replaced = await provider.replaceFeature(
        fakeReq(db),
        'qgis_polygons',
        '2',
        qgisShapedBody({
          id: 2,
          geometry: newGeometry,
          properties: { name: 'Zone B replaced', zone_type: 'commercial', geometry: null },
        }) as any
      );

      expect(replaced?.geometry).toEqual(newGeometry);
      expect(replaced?.properties.name).toBe('Zone B replaced');
      expect(replaced?.properties.geometry).toBeUndefined();

      const reread = await provider.getFeature(fakeReq(db), 'qgis_polygons', '2');
      expect(reread?.geometry).toEqual(newGeometry);

      // Restore Zone B's original state so later tests (which assume the
      // fixture is untouched) aren't affected.
      await provider.replaceFeature(fakeReq(db), 'qgis_polygons', '2', {
        type: 'Feature',
        id: 2,
        geometry: { type: 'Polygon', coordinates: [[[2, 0], [2, 1], [3, 1], [3, 0], [2, 0]]] },
        properties: { name: 'Zone B', zone_type: 'commercial' },
      });
    });

    it('PATCH: the same QGIS-shaped body does not null out the stored geometry (properties.geometry is excluded, not applied)', async () => {
      const before = await provider.getFeature(fakeReq(db), 'qgis_polygons', '3');
      expect(before?.geometry).not.toBeNull();

      // `updateFeature` (PATCH) does not apply a top-level `feature.geometry`
      // to the geometry column at all (a pre-existing limitation, unrelated
      // to this fix) — only `properties` are ever written. The assertion
      // that matters here is narrower than PUT's: the artifact key must not
      // reach the geometry column and null it out.
      const updated = await provider.updateFeature(fakeReq(db), 'qgis_polygons', '3', {
        feature: qgisShapedBody({
          id: 3,
          geometry: { type: 'Polygon', coordinates: [[[30, 30], [30, 31], [31, 31], [31, 30], [30, 30]]] },
          properties: { name: 'Zone C patched', geometry: null },
        }) as any,
      });

      expect(updated?.properties.name).toBe('Zone C patched');
      expect(updated?.geometry).not.toBeNull();
      expect(updated?.geometry).toEqual(before?.geometry);

      const reread = await provider.getFeature(fakeReq(db), 'qgis_polygons', '3');
      expect(reread?.geometry).toEqual(before?.geometry);

      // Restore.
      await provider.updateFeature(fakeReq(db), 'qgis_polygons', '3', {
        feature: { type: 'Feature', id: 3, geometry: null, properties: { name: 'Zone C' } },
      });
    });

    it('the exclusion keys off the discovered column name, not the literal string "geometry" (table geometry column is "geom")', async () => {
      const newGeometry = { type: 'Polygon', coordinates: [[[40, 40], [40, 41], [41, 41], [41, 40], [40, 40]]] };

      const created = await provider.createFeature(fakeReq(db), 'qgis_polygons_geom_named', {
        type: 'Feature',
        id: 2,
        geometry: newGeometry,
        // The QGIS artifact this time targets `geom`, matching this table's
        // actual (discovered) geometry column — not the literal 'geometry'.
        properties: { id: 2, name: 'Named geom', geom: null },
      } as any);

      expect(created).not.toBeNull();
      expect(created?.geometry).toEqual(newGeometry);
      expect(created?.properties.geom).toBeUndefined();
      expect(created?.properties.name).toBe('Named geom');

      const reread = await provider.getFeature(fakeReq(db), 'qgis_polygons_geom_named', '2');
      expect(reread?.geometry).toEqual(newGeometry);

      expect(await provider.deleteFeature(fakeReq(db), 'qgis_polygons_geom_named', '2')).toBe(true);
    });

    it('a property genuinely null under a different key still round-trips (the exclusion is narrow)', async () => {
      const created = await provider.createFeature(fakeReq(db), 'qgis_polygons', {
        type: 'Feature',
        id: 51,
        geometry: { type: 'Polygon', coordinates: [[[50, 50], [50, 51], [51, 51], [51, 50], [50, 50]]] },
        // `zone_type` is a real column, genuinely null — must not be swept
        // up by an over-broad exclusion.
        properties: { id: 51, name: 'Null zone', zone_type: null },
      } as any);

      expect(created).not.toBeNull();
      expect(created?.properties.zone_type).toBeNull();
      expect('zone_type' in (created?.properties ?? {})).toBe(true);

      expect(await provider.deleteFeature(fakeReq(db), 'qgis_polygons', '51')).toBe(true);
    });

    it('POST with a client-supplied id that already exists is a clean 409, not an HTML 500 leaking SQL', async () => {
      const { baseUrl, close } = startServer();
      try {
        const res = await fetch(`${baseUrl}/collections/qgis_polygons/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/geo+json' },
          body: JSON.stringify(
            qgisShapedBody({
              id: 1, // already exists in the fixture
              geometry: { type: 'Polygon', coordinates: [[[60, 60], [60, 61], [61, 61], [61, 60], [60, 60]]] },
              properties: { name: 'Duplicate id', zone_type: 'test', geometry: null },
            })
          ),
        });
        const contentType = res.headers.get('content-type') ?? '';
        const bodyText = await res.text();

        expect(res.status).toBe(409);
        expect(contentType).toContain('json');
        expect(bodyText).not.toContain('<html');
        expect(bodyText).not.toContain('INSERT INTO');
        expect(bodyText).not.toContain('qgis_polygons');

        const body = JSON.parse(bodyText) as { code: string; description: string };
        expect(body.description).toContain('id');
        expect(body.description).toContain('1');
      } finally {
        close();
      }
    });
  });

  describe('server-assigned ids (Part 4: letting the database assign the id on create)', () => {
    // The exact captured QGIS "add feature" body shape: a top-level
    // `geometry`, a `properties.geometry` artifact (see the describe block
    // above), and — the part that matters here — an `id` the client picked
    // from its own stale view of the layer.
    function qgisShapedBody(overrides: {
      id?: number;
      geometry: unknown;
      properties: Record<string, unknown>;
    }) {
      return {
        type: 'Feature',
        geometry: overrides.geometry,
        properties: overrides.id === undefined ? { ...overrides.properties } : { id: overrides.id, ...overrides.properties },
      };
    }

    function startServer(): { baseUrl: string; close: () => void } {
      const app = express();
      app.use((_req, res, next) => {
        res.locals.db = db;
        next();
      });
      const ogc = new OGCAPI(provider, app, {});
      app.use(ogc.getRouter());
      const server = app.listen(0);
      const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
      return { baseUrl, close: () => server.close() };
    }

    it('POST without an id to a sequence-backed table gets a generated id in both the body and the Location header, and is retrievable there', async () => {
      const { baseUrl, close } = startServer();
      try {
        const res = await fetch(`${baseUrl}/collections/seq_polygons/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/geo+json' },
          body: JSON.stringify({
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [[[70, 70], [70, 71], [71, 71], [71, 70], [70, 70]]] },
            properties: { name: 'No id supplied', zone_type: 'test' },
          }),
        });
        const body = (await res.json()) as { id: number | string; properties: { name: string } };

        expect(res.status).toBe(201);
        // Generated by the sequence (START 100) — the seeded fixture only
        // goes up to 3, so any assigned id must be outside that range.
        expect(Number(body.id)).toBeGreaterThanOrEqual(100);
        expect(body.properties.name).toBe('No id supplied');

        const location = res.headers.get('location');
        expect(location).toBeTruthy();
        expect(location).toContain(`/collections/seq_polygons/items/${body.id}`);

        // Retrievable at the id the server actually assigned.
        const getRes = await fetch(`${baseUrl}/collections/seq_polygons/items/${body.id}`);
        expect(getRes.status).toBe(200);
        const fetched = (await getRes.json()) as { properties: { name: string } };
        expect(fetched.properties.name).toBe('No id supplied');
      } finally {
        close();
      }
    });

    it('POST with a client-supplied id that COLLIDES with an existing row, against a sequence-backed table, gets 201 with a DIFFERENT generated id — the QGIS case', async () => {
      // This is the core regression test: id 1 already exists in
      // `seq_polygons`. Before this feature, this would 409 (the existing,
      // correct-but-unhelpful behaviour QGIS's "add feature" gets stuck on).
      // If the id-discarding logic in `createFeature` were removed, this
      // request would revert to inserting the literal id 1 and collide,
      // reproducing the 409 — that's the failure mode this test is written
      // to catch.
      const { baseUrl, close } = startServer();
      try {
        const res = await fetch(`${baseUrl}/collections/seq_polygons/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/geo+json' },
          body: JSON.stringify(
            qgisShapedBody({
              id: 1, // collides with the seeded row
              geometry: { type: 'Polygon', coordinates: [[[80, 80], [80, 81], [81, 81], [81, 80], [80, 80]]] },
              properties: { name: 'Colliding id', zone_type: 'test', geometry: null },
            })
          ),
        });
        const body = (await res.json()) as { id: number | string; properties: { name: string } };

        expect(res.status).toBe(201);
        expect(Number(body.id)).not.toBe(1);
        expect(Number(body.id)).toBeGreaterThanOrEqual(100);
        expect(body.properties.name).toBe('Colliding id');

        // The original row at id 1 must be untouched — the client's value
        // was discarded, not applied as an overwrite.
        const original = await provider.getFeature(fakeReq(db), 'seq_polygons', '1');
        expect(original?.properties.name).toBe('Zone A');

        const location = res.headers.get('location');
        expect(location).toContain(`/collections/seq_polygons/items/${body.id}`);
      } finally {
        close();
      }
    });

    it('POST with a client-supplied, non-colliding id to a table WITHOUT a default: honoured, unchanged from today', async () => {
      const created = await provider.createFeature(fakeReq(db), 'qgis_polygons', {
        type: 'Feature',
        id: 77,
        geometry: { type: 'Polygon', coordinates: [[[90, 90], [90, 91], [91, 91], [91, 90], [90, 90]]] },
        properties: { id: 77, name: 'Honoured id', zone_type: 'test' },
      } as any);

      expect(created).not.toBeNull();
      // The client's id was actually used — not silently replaced.
      expect(Number(created?.id)).toBe(77);

      const reread = await provider.getFeature(fakeReq(db), 'qgis_polygons', '77');
      expect(reread?.properties.name).toBe('Honoured id');

      expect(await provider.deleteFeature(fakeReq(db), 'qgis_polygons', '77')).toBe(true);
    });

    it('POST with a client-supplied id that collides, to a table WITHOUT a default: still 409, unchanged from today', async () => {
      let caught: unknown;
      try {
        await provider.createFeature(fakeReq(db), 'qgis_polygons', {
          type: 'Feature',
          id: 2, // already exists
          geometry: null,
          properties: { id: 2, name: 'Should collide', zone_type: 'test' },
        } as any);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(FeatureValidationError);
      expect((caught as FeatureValidationError).status).toBe(409);
    });

    it('the full QGIS-captured body shape (stray properties.geometry, plus a colliding id) against a sequence-backed table: 201, correct geometry, generated id', async () => {
      // Shaped exactly like the request captured from a real QGIS client:
      // top-level geometry, a same-named `properties.geometry` (null)
      // artifact left over from QGIS treating the geometry column as an
      // ordinary attribute field, and an `id` picked from QGIS's own,
      // possibly-stale view of the layer.
      const newGeometry = { type: 'Polygon', coordinates: [[[95, 95], [95, 96], [96, 96], [96, 95], [95, 95]]] };
      const { baseUrl, close } = startServer();
      try {
        const res = await fetch(`${baseUrl}/collections/seq_polygons/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/geo+json' },
          body: JSON.stringify(
            qgisShapedBody({
              id: 3, // collides with the seeded 'Zone C'
              geometry: newGeometry,
              properties: { name: 'QGIS added zone', zone_type: 'test', geometry: null },
            })
          ),
        });
        const body = (await res.json()) as {
          id: number | string;
          geometry: unknown;
          properties: Record<string, unknown>;
        };

        expect(res.status).toBe(201);
        expect(Number(body.id)).not.toBe(3);
        expect(Number(body.id)).toBeGreaterThanOrEqual(100);
        expect(body.geometry).toEqual(newGeometry);
        expect(body.properties.name).toBe('QGIS added zone');
        // The stray properties.geometry artifact must not leak back out.
        expect(body.properties.geometry).toBeUndefined();

        const reread = await provider.getFeature(fakeReq(db), 'seq_polygons', String(body.id));
        expect(reread?.geometry).toEqual(newGeometry);
      } finally {
        close();
      }
    });

    it('two consecutive POSTs (no id supplied) to a sequence-backed table get distinct generated ids', async () => {
      const first = await provider.createFeature(fakeReq(db), 'seq_polygons', {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[110, 110], [110, 111], [111, 111], [111, 110], [110, 110]]] },
        properties: { name: 'First' },
      } as any);
      const second = await provider.createFeature(fakeReq(db), 'seq_polygons', {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[120, 120], [120, 121], [121, 121], [121, 120], [120, 120]]] },
        properties: { name: 'Second' },
      } as any);

      expect(first?.id).toBeDefined();
      expect(second?.id).toBeDefined();
      expect(first?.id).not.toBe(second?.id);
      expect(first?.properties.name).toBe('First');
      expect(second?.properties.name).toBe('Second');
    });

    it('a sequence-defaulted id column is still x-ogc-role: id, but is no longer listed as required, and IS readOnly', async () => {
      const schema = await provider.getSchema(fakeReq(db), 'seq_polygons');
      const properties = schema.properties as Record<string, { 'x-ogc-role'?: string; readOnly?: boolean }>;
      const required = schema.required as string[];

      // Still identified as the id column — this is metadata about what the
      // column *is*, unaffected by whether the database can assign it.
      expect(properties.id['x-ogc-role']).toBe('id');

      // No longer required: the server assigns it on create (see
      // `createFeature`), so a client is not expected to supply one — and
      // listing it as required would tell a well-behaved client (QGIS
      // included) to demand a value from the user that the server is going
      // to discard anyway.
      expect(required).not.toContain('id');
      // Other NOT NULL-by-virtue-of-being-a-column-that-happens-to-have-data
      // constraints are unaffected — this table has no other NOT NULL
      // column, so nothing else to assert here beyond "id" being absent.

      // The new assertion: the server silently discards a client-supplied
      // id here (see `createFeature`'s use of `idColumnWithDefault`), so
      // Part 5's `readOnly` must say so — this is exactly what tells QGIS's
      // schema parser to grey the field out instead of letting a user type
      // an id that collides with an existing row.
      expect(properties.id.readOnly).toBe(true);
    });

    it('an id column WITHOUT a default is still listed as required (unchanged), and is NOT readOnly — contrast with the sequence-backed case above', async () => {
      // `qgis_polygons.id` has no column default at all.
      const schema = await provider.getSchema(fakeReq(db), 'qgis_polygons');
      const properties = schema.properties as Record<string, { 'x-ogc-role'?: string; readOnly?: boolean }>;
      const required = schema.required as string[];

      expect(required).toContain('id');
      // The server cannot assign a value here, so the client is required to
      // supply one — marking it readOnly would tell a well-behaved client
      // not to send the one value that makes create work. `x-ogc-role: 'id'`
      // is unaffected by the absence of a default.
      expect(properties.id['x-ogc-role']).toBe('id');
      expect(properties.id.readOnly).toBeUndefined();
    });

    it('a non-identifier column with a database default is never marked readOnly — readOnly tracks the id column specifically, not "has a default"', async () => {
      const schema = await provider.getSchema(fakeReq(db), 'defaulted_status');
      const properties = schema.properties as Record<string, { 'x-ogc-role'?: string; readOnly?: boolean }>;
      const required = schema.required as string[];

      // `status` defaults but is an ordinary writable attribute: not the id,
      // so no `x-ogc-role` and no `readOnly`, regardless of its default.
      expect(properties.status['x-ogc-role']).toBeUndefined();
      expect(properties.status.readOnly).toBeUndefined();

      // `id` here has no default at all, so it stays required and is not
      // readOnly — same shape as the `qgis_polygons` case above, just
      // co-located with a defaulted non-id column in the same table.
      expect(properties.id['x-ogc-role']).toBe('id');
      expect(properties.id.readOnly).toBeUndefined();
      expect(required).toContain('id');
    });
  });
});
