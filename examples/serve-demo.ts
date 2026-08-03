/**
 * Serves examples/demo.duckdb over OGC API - Features, for manual testing in
 * QGIS (or any OGC API - Features client).
 *
 * Build the database first:
 *   npx tsx examples/build-demo-duckdb.ts
 *
 * Then run this:
 *   npx tsx examples/serve-demo.ts
 *
 * The demo database holds three prefixed tables — demo_points, demo_lines,
 * demo_polygons — so tenant `demo` exposes collections `points`, `lines` and
 * `polygons`. The prefix never appears in a URL.
 *
 * Every route is behind a JWT carried in the URL path: `/:token/ogc/...`. The
 * token's `db` claim selects the tenant, so the database id never appears in
 * the URL either — the token is what grants access to `demo`. An invalid,
 * tampered-with, or expired token gets a 403. The server prints a freshly
 * signed 8h token on startup; see `examples/demo-jwt.ts` for the signing and
 * verification, and `examples/mint-token.ts` to mint more.
 *
 * In QGIS: Layer > Add Layer > Add WFS / OGC API - Features Layer, create a
 * new connection pointing at the landing page printed on startup.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { DuckDBInstance } from '@duckdb/node-api';
import { OGCAPI } from '../src/index.js';
import { PrefixedDuckDBProvider } from './prefixed-duckdb-provider.js';
import { getToken, requireToken, TOKEN_TTL } from './demo-jwt.js';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = join(here, 'demo.duckdb');

// The application owns the connection: it opens it, loads the extensions it
// needs, and closes it. The provider only borrows it, per request, from
// res.locals.db.
const instance = await DuckDBInstance.create(dbPath);
const db = await instance.connect();
await db.run('INSTALL spatial; LOAD spatial;');

const KNOWN_TENANTS = new Set(['demo']);

const provider = new PrefixedDuckDBProvider({ name: 'PrefixedDuckDBProvider' });

const app = express();
const port = Number(process.env.PORT) || 3005;

const ogcAPI = new OGCAPI(provider, app, {
  title: 'Demo OGC API - Features',
  description: 'Points, lines and polygons from a local DuckDB file',
});

// Tokens are long and, more importantly, they are credentials — a full token
// in a log line is a copy-pasteable key. Collapse it to `<token>` so the log
// stays readable and doesn't hand out access to anyone reading the console.
function redactToken(url: string): string {
  return url.replace(/^\/[^/]+\/ogc\b/, '/<token>/ogc');
}

// Request log, so you can see exactly what a client (e.g. QGIS) asks for —
// in particular whether it ever fetches /schema, and whether it issues any
// write requests. Logged on 'finish' so the status code is known.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const line = `${req.method} ${redactToken(req.originalUrl)} -> ${res.statusCode} (${Date.now() - started}ms)`;
    const accept = req.get('accept');
    console.log(accept ? `${line}  accept: ${accept}` : line);
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      console.log(`   body: ${JSON.stringify(req.body).slice(0, 400)}`);
    }
  });
  next();
});

// Plain Express middleware — no library hooks involved.
//
// First gate: verify the token in the path and resolve the tenant from its
// `db` claim onto res.locals.key. Rejects with 403 before anything touches the
// database.
app.use('/:token/ogc', requireToken(KNOWN_TENANTS));

// Then hand the provider the connection it borrows for this request. Only
// reached once the token verified, so an unauthenticated request never gets
// this far.
app.use('/:token/ogc', (_req, res, next) => {
  res.locals.db = db;
  next();
});

// The router is mounted under the token segment, so req.baseUrl is
// `/<token>/ogc` and every link the library generates keeps the token in it —
// a client that starts from the landing page can crawl the whole API without
// ever needing to re-attach the token itself.
app.use('/:token/ogc', ogcAPI.getRouter());

app.use('/', (_req, res) => {
  res.send(
    'Demo OGC API - Features. Landing page: /<token>/ogc — mint a token with: npx tsx examples/mint-token.ts demo'
  );
});

const server = app.listen(port, () => {
  // A fresh token each boot, so the printed URLs are always usable. Restarting
  // the server invalidates nothing (the old token stays valid until it
  // expires) — it just issues another one.
  //
  // Read-only on purpose. These URLs are the ones you paste into QGIS, and QGIS
  // saves them into its project file — so this is exactly the token most likely
  // to end up somewhere you didn't intend. Writes need `mint-token.ts --rw`.
  const token = getToken({ db: 'demo', sub: 'demo-user', scope: 'ro' });
  const base = `http://localhost:${port}/${token}/ogc`;
  console.log('🌍 Demo OGC API - Features server');
  console.log('================================');
  console.log(`  Landing page (use this in QGIS):  ${base}`);
  console.log(`  Conformance:                      ${base}/conformance`);
  console.log(`  Collections:                      ${base}/collections`);
  console.log(`  Points:                           ${base}/collections/points/items`);
  console.log(`  Lines:                            ${base}/collections/lines/items`);
  console.log(`  Polygons:                         ${base}/collections/polygons/items`);
  console.log('');
  console.log(`  The token above is READ-ONLY and expires in ${TOKEN_TTL}.`);
  console.log('  Writes (POST/PUT/PATCH/DELETE) need a read-write token:');
  console.log(`    npx tsx examples/mint-token.ts demo --rw --port ${port}`);
  console.log('');
  console.log('  403 Invalid or expired token          — bad, tampered-with or expired token');
  console.log('  403 Token is read-only; …             — valid token, but a write with scope=ro');
  console.log('');
  console.log('Press Ctrl+C to stop');
});

function shutdown(signal: string) {
  console.log(`\n🛑 ${signal} received: closing`);
  server.close(() => {
    db.disconnectSync();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
