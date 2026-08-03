import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { OGCAPI } from '../src/index.js';
import { PrefixedDuckDBProvider } from '../examples/prefixed-duckdb-provider.js';
import { getToken, requireToken, SECRET_KEY } from '../examples/demo-jwt.js';

/**
 * Importing an `examples/` file from a test is intentional — same reasoning as
 * `prefixed-duckdb-provider.test.ts`: the documented pattern is only honest if
 * it's exercised.
 *
 * What matters here is the *gate*, so the negative cases carry the weight: a
 * token that is expired, signed with the wrong key, tampered with, or names a
 * database this server doesn't serve must all be refused, and refused
 * identically. A test that only checks "a good token works" would still pass if
 * verification were skipped entirely.
 */

const KNOWN_TENANTS = new Set(['demo']);

describe('demo JWT-in-path gate', () => {
  let instance: DuckDBInstance;
  let db: DuckDBConnection;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
    db = await instance.connect();
    await db.run('INSTALL spatial; LOAD spatial;');
    await db.run(`
      CREATE TABLE demo_cities (id INTEGER PRIMARY KEY, name VARCHAR);
      INSERT INTO demo_cities VALUES (1, 'Demo City');
    `);

    const provider = new PrefixedDuckDBProvider({ name: 'PrefixedDuckDBProvider' });
    const app = express();
    const ogcAPI = new OGCAPI(provider, app, { title: 'Demo', description: 'demo' });

    // Exactly the wiring serve-demo.ts uses.
    app.use('/:token/ogc', requireToken(KNOWN_TENANTS));
    app.use('/:token/ogc', (_req, res, next) => {
      res.locals.db = db;
      next();
    });
    app.use('/:token/ogc', ogcAPI.getRouter());

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        base = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.disconnectSync();
  });

  function get(token: string, path = '/collections') {
    return fetch(`${base}/${token}/ogc${path}`);
  }

  it('serves the API with a valid token', async () => {
    const token = getToken({ db: 'demo', sub: 'demo-user' });

    const landing = await get(token, '');
    expect(landing.status).toBe(200);

    const collections = await get(token);
    expect(collections.status).toBe(200);
    const body = (await collections.json()) as { collections: { id: string }[] };
    // The token's `db: 'demo'` claim resolved to res.locals.key = 'demo', so
    // the provider stripped the demo_ prefix.
    expect(body.collections.map((c) => c.id)).toEqual(['cities']);
  });

  it('keeps the token in every generated link, so a client can crawl from the landing page', async () => {
    const token = getToken({ db: 'demo' });
    const landing = (await (await get(token, '')).json()) as {
      links: { rel: string; href: string }[];
    };

    const self = landing.links.find((l) => l.rel === 'self');
    expect(self?.href).toContain(`/${token}/ogc`);

    // Not just formatted correctly — actually followable, which is the point.
    const conformance = landing.links.find((l) => l.rel === 'conformance');
    expect(conformance).toBeDefined();
    expect((await fetch(conformance!.href)).status).toBe(200);
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = jwt.sign({ db: 'demo' }, 'attacker-secret', { expiresIn: '8h' });
    const res = await get(forged);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: '403', description: 'Invalid or expired token' });
  });

  it('rejects an expired token', async () => {
    const expired = jwt.sign({ db: 'demo' }, SECRET_KEY, { expiresIn: '-1h' });
    expect((await get(expired)).status).toBe(403);
  });

  it('rejects a tampered-with token', async () => {
    const tampered = `${getToken({ db: 'demo' }).slice(0, -3)}AAA`;
    expect((await get(tampered)).status).toBe(403);
  });

  it('rejects a validly signed token for a database this server does not serve', async () => {
    const otherTenant = jwt.sign({ db: 'globex' }, SECRET_KEY, { expiresIn: '8h' });
    expect((await get(otherTenant)).status).toBe(403);
  });

  it('rejects a validly signed token with no db claim', async () => {
    const noClaim = jwt.sign({ sub: 'nobody' }, SECRET_KEY, { expiresIn: '8h' });
    expect((await get(noClaim)).status).toBe(403);
  });

  it('rejects a token whose payload is a bare string rather than claims', async () => {
    const bareString = jwt.sign('demo', SECRET_KEY);
    expect((await get(bareString)).status).toBe(403);
  });

  it('rejects garbage in the token position', async () => {
    expect((await get('not-a-token')).status).toBe(403);
    expect((await get('x', '/collections/cities/items')).status).toBe(403);
  });

  it('refuses writes as well as reads, not just the read paths', async () => {
    // The gate is mounted before the router, so it covers every method. Worth
    // asserting explicitly: an auth check that only guards GET is a common and
    // expensive mistake.
    const res = await fetch(`${base}/not-a-token/ogc/collections/cities/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/geo+json' },
      body: JSON.stringify({ type: 'Feature', properties: { name: 'x' }, geometry: null }),
    });
    expect(res.status).toBe(403);
  });

  it('does not distinguish failure reasons in its response', async () => {
    // Same status and same body for every rejection: telling a caller *why*
    // their token failed tells someone probing with guesses which part of the
    // guess was right.
    const bodies = await Promise.all(
      [
        jwt.sign({ db: 'demo' }, 'attacker-secret', { expiresIn: '8h' }),
        jwt.sign({ db: 'demo' }, SECRET_KEY, { expiresIn: '-1h' }),
        jwt.sign({ db: 'globex' }, SECRET_KEY, { expiresIn: '8h' }),
        'not-a-token',
      ].map(async (token) => {
        const res = await get(token);
        return `${res.status} ${await res.text()}`;
      })
    );

    expect(new Set(bodies).size).toBe(1);
  });
});
