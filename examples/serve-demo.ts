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
 * In QGIS: Layer > Add Layer > Add WFS / OGC API - Features Layer, create a
 * new connection pointing at the landing page printed on startup.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { DuckDBInstance } from '@duckdb/node-api';
import { OGCAPI } from '../src/index.js';
import { PrefixedDuckDBProvider } from './prefixed-duckdb-provider.js';

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

// Plain Express middleware — no library hooks involved. It resolves the tenant
// and puts the connection and the key where the provider looks for them.
app.use('/root/:dbid', (req, res, next) => {
  if (!KNOWN_TENANTS.has(req.params.dbid)) {
    res.status(404).json({
      code: '404',
      description: `Unknown database ${req.params.dbid}`,
    });
    return;
  }
  res.locals.db = db;
  res.locals.key = req.params.dbid;
  next();
});

app.use('/root/:dbid', ogcAPI.getRouter());

app.use('/', (_req, res) => {
  res.send('Demo OGC API - Features. Landing page: /root/demo');
});

const server = app.listen(port, () => {
  const base = `http://localhost:${port}/root/demo`;
  console.log('🌍 Demo OGC API - Features server');
  console.log('================================');
  console.log(`  Landing page (use this in QGIS):  ${base}`);
  console.log(`  Conformance:                      ${base}/conformance`);
  console.log(`  Collections:                      ${base}/collections`);
  console.log(`  Points:                           ${base}/collections/points/items`);
  console.log(`  Lines:                            ${base}/collections/lines/items`);
  console.log(`  Polygons:                         ${base}/collections/polygons/items`);
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
