import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { ProviderRequest } from '../src/index.js';
import { PrefixedDuckDBProvider } from '../examples/prefixed-duckdb-provider.js';
import type { PrefixedLocals } from '../examples/prefixed-duckdb-provider.js';

/**
 * Importing an `examples/` file from a test is intentional: it keeps the
 * documented copy-paste pattern honest — if the pattern in
 * `examples/prefixed-duckdb-provider.ts` ever stops working, this suite
 * fails, the same as any other library code would.
 */
function fakeReq(
  db: DuckDBConnection,
  locals: Partial<PrefixedLocals> = {}
): ProviderRequest<Record<string, string>, PrefixedLocals> {
  const res = { locals: { db, ...locals } };
  return { params: {}, query: {}, baseUrl: '', res } as unknown as ProviderRequest<
    Record<string, string>,
    PrefixedLocals
  >;
}

async function connect(instance: DuckDBInstance): Promise<DuckDBConnection> {
  const conn = await instance.connect();
  await conn.run('INSTALL spatial; LOAD spatial;');
  return conn;
}

describe('PrefixedDuckDBProvider', () => {
  let instance: DuckDBInstance;
  let db: DuckDBConnection;
  let provider: PrefixedDuckDBProvider;

  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
    db = await connect(instance);

    // Seed two tenants sharing one database, so isolation is a real
    // cross-table check, not just "one table exists".
    await db.run(`
      CREATE TABLE acme_cities (id INTEGER PRIMARY KEY, name VARCHAR);
      INSERT INTO acme_cities VALUES (1, 'Acme City');
      CREATE TABLE acme_parks (id INTEGER PRIMARY KEY, name VARCHAR);
      INSERT INTO acme_parks VALUES (1, 'Acme Park');

      CREATE TABLE globex_cities (id INTEGER PRIMARY KEY, name VARCHAR);
      INSERT INTO globex_cities VALUES (1, 'Globex City');

      -- An unprefixed table that belongs to no tenant.
      CREATE TABLE cities (id INTEGER PRIMARY KEY, name VARCHAR);
      INSERT INTO cities VALUES (1, 'Flat City');
    `);

    provider = new PrefixedDuckDBProvider({ name: 'PrefixedDuckDBProvider' });
  });

  afterAll(() => {
    db.disconnectSync();
  });

  it("scopes discovery to a tenant's own prefixed tables, stripped of the prefix", async () => {
    const acmeIds = (await provider.getCollections(fakeReq(db, { key: 'acme' }))).map((c) => c.id);
    expect(acmeIds.sort()).toEqual(['cities', 'parks']);

    const globexIds = (await provider.getCollections(fakeReq(db, { key: 'globex' }))).map((c) => c.id);
    expect(globexIds).toEqual(['cities']);
  });

  it('does not let one tenant see or read the other tenant’s collections', async () => {
    // acme's "cities" resolves to acme_cities, not globex_cities or the
    // flat unprefixed "cities" table — each tenant's read is genuinely
    // scoped, not just a list that happens to look right.
    const acmeCities = await provider.getFeature(fakeReq(db, { key: 'acme' }), 'cities', '1');
    expect(acmeCities?.properties.name).toBe('Acme City');

    const globexCities = await provider.getFeature(fakeReq(db, { key: 'globex' }), 'cities', '1');
    expect(globexCities?.properties.name).toBe('Globex City');

    // acme has no "parks_from_globex"-style collection — and globex, which
    // has no parks table at all, gets a clean null, not acme's.
    expect(await provider.getCollection(fakeReq(db, { key: 'globex' }), 'parks')).toBeNull();

    // acme cannot address globex's table by constructing a collection id
    // that collides with it: physicalTableName always prepends acme's own
    // key, so this can only ever resolve to `acme_globex_cities`, which
    // does not exist. getCollection does a plain existence check against
    // information_schema.tables, so a nonexistent physical table is a clean
    // null rather than an error.
    expect(await provider.getCollection(fakeReq(db, { key: 'acme' }), 'globex_cities')).toBeNull();
  });

  it('reads resolve to the prefixed physical table, not the unprefixed one', async () => {
    const feature = await provider.getFeature(fakeReq(db, { key: 'acme' }), 'cities', '1');
    expect(feature?.properties.name).toBe('Acme City');
    expect(feature?.properties.name).not.toBe('Flat City');
  });

  it('throws when res.locals.key is missing entirely', async () => {
    const bare = {
      params: {},
      query: {},
      baseUrl: '',
      res: { locals: { db } },
    } as unknown as ProviderRequest<Record<string, string>, PrefixedLocals>;

    await expect(provider.getCollections(bare)).rejects.toThrow(/res\.locals\.key/);
  });

  it('throws when res.locals.key is an empty string', async () => {
    await expect(provider.getCollections(fakeReq(db, { key: '' }))).rejects.toThrow(/res\.locals\.key/);
  });

  it('throws when res.locals.key contains an underscore', async () => {
    await expect(provider.getCollections(fakeReq(db, { key: 'acme_eu' }))).rejects.toThrow(
      /res\.locals\.key/
    );
  });

  it('throws when res.locals.key contains other punctuation', async () => {
    await expect(provider.getCollections(fakeReq(db, { key: 'ac-me' }))).rejects.toThrow(
      /res\.locals\.key/
    );
  });
});
