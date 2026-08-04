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
    // Installed once in test/global-setup.ts, so this only has to load it.
    await db.run('LOAD spatial;');
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
    // Guarded because `beforeAll` may have thrown before assigning these. An
    // unguarded teardown reports its own `Cannot read properties of undefined`
    // on top of the real setup failure, which buries the error that actually
    // needs reading.
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    db?.disconnectSync();
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

  describe('scope claim', () => {
    function write(token: string, method: string, path: string, body?: unknown) {
      return fetch(`${base}/${token}/ogc${path}`, {
        method,
        headers: { 'content-type': 'application/geo+json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }

    it('lets a read-write token actually write', async () => {
      const rw = getToken({ db: 'demo', scope: 'rw' });

      const created = await write(rw, 'POST', '/collections/cities/items', {
        type: 'Feature',
        id: 100,
        geometry: null,
        properties: { id: 100, name: 'Written City' },
      });
      expect(created.status).toBe(201);

      // Asserting the write landed, not merely that the gate let it past —
      // otherwise this test would still pass if the handler silently no-oped.
      const read = await get(rw, '/collections/cities/items/100');
      expect(read.status).toBe(200);
      expect(((await read.json()) as any).properties.name).toBe('Written City');

      expect((await write(rw, 'DELETE', '/collections/cities/items/100')).status).toBe(204);
    });

    it('refuses every write method for a read-only token, with a distinguishable reason', async () => {
      const ro = getToken({ db: 'demo', scope: 'ro' });

      for (const [method, path] of [
        ['POST', '/collections/cities/items'],
        ['PUT', '/collections/cities/items/1'],
        ['PATCH', '/collections/cities/items/1'],
        ['DELETE', '/collections/cities/items/1'],
      ] as const) {
        const res = await write(ro, method, path, {
          type: 'Feature',
          geometry: null,
          properties: { name: 'nope' },
        });
        expect(res.status, method).toBe(403);
        const body = (await res.json()) as { description: string };
        expect(body.description, method).toContain('read-only');
        expect(body.description, method).toContain(method);
      }

      // And the row it tried to touch is untouched.
      const survivor = await get(ro, '/collections/cities/items/1');
      expect(survivor.status).toBe(200);
      expect(((await survivor.json()) as any).properties.name).toBe('Demo City');
    });

    it('still allows reads for a read-only token', async () => {
      const ro = getToken({ db: 'demo', scope: 'ro' });
      expect((await get(ro, '/collections/cities/items')).status).toBe(200);
      expect((await write(ro, 'HEAD', '/collections')).status).toBe(200);
    });

    it('treats a token with no scope claim as read-only', async () => {
      // Fails closed. A token minted without thinking about scope must not get
      // write access by default.
      const noScope = getToken({ db: 'demo' });
      expect((await get(noScope, '/collections')).status).toBe(200);
      expect(
        (await write(noScope, 'DELETE', '/collections/cities/items/1')).status
      ).toBe(403);
    });

    it('treats an unrecognized scope value as read-only, not as permissive', async () => {
      // Only the exact string 'rw' grants writes, so a typo in a mint call
      // degrades to read-only instead of silently handing out DELETE.
      for (const scope of ['RW', 'rw ', 'write', 'admin', '', 1, null, ['rw']]) {
        const token = jwt.sign({ db: 'demo', scope }, SECRET_KEY, { expiresIn: '8h' });
        const res = await write(token, 'DELETE', '/collections/cities/items/1');
        expect(res.status, JSON.stringify(scope)).toBe(403);
      }

      expect((await get(getToken({ db: 'demo' }), '/collections/cities/items/1')).status).toBe(200);
    });

    it('does not let scope=rw substitute for a valid signature, live token or known db', async () => {
      // Scope widens what a *valid* token may do; it must never be a way around
      // verification itself.
      const forged = jwt.sign({ db: 'demo', scope: 'rw' }, 'attacker-secret', { expiresIn: '8h' });
      const expired = jwt.sign({ db: 'demo', scope: 'rw' }, SECRET_KEY, { expiresIn: '-1h' });
      const otherTenant = jwt.sign({ db: 'globex', scope: 'rw' }, SECRET_KEY, { expiresIn: '8h' });

      for (const token of [forged, expired, otherTenant]) {
        const res = await write(token, 'DELETE', '/collections/cities/items/1');
        expect(res.status).toBe(403);
        // The vague message, not the read-only one — these tokens are not
        // usable at all, and saying which check failed would help a prober.
        expect(((await res.json()) as { description: string }).description).toBe(
          'Invalid or expired token'
        );
      }
    });
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
