/**
 * Mints a demo JWT for the server in `serve-demo.ts`.
 *
 *   npx tsx examples/mint-token.ts                        # tenant `demo`, read-only
 *   npx tsx examples/mint-token.ts demo                   # same, explicit
 *   npx tsx examples/mint-token.ts demo --rw              # read-write
 *   npx tsx examples/mint-token.ts demo --port 3005       # also print ready-to-use URLs
 *
 * Read-only is the default, deliberately: you have to ask for write access,
 * rather than getting it because you forgot to opt out. See the `DemoScope`
 * comment in `demo-jwt.ts` for why the two are worth keeping apart.
 *
 * Set DEMO_JWT_SECRET to the same value the server uses, or leave it unset on
 * both sides to use the demo default.
 */

import { getToken, TOKEN_TTL } from './demo-jwt.js';
import type { DemoScope } from './demo-jwt.js';

const argv = process.argv.slice(2);

const scope: DemoScope = argv.includes('--rw') ? 'rw' : 'ro';

const portFlagIndex = argv.indexOf('--port');
const flagPort = portFlagIndex === -1 ? undefined : argv[portFlagIndex + 1];

// Positional args, ignoring flags and the value consumed by --port. Kept
// positional-friendly so `mint-token.ts demo 3005` still works.
//
// The `portFlagIndex !== -1` guard matters: without it, a missing --port makes
// portFlagIndex -1, and `i !== portFlagIndex + 1` then skips index 0 — eating
// the db argument, so `mint-token.ts demo 3005` minted a token for tenant
// "3005".
const portValueIndex = portFlagIndex === -1 ? -1 : portFlagIndex + 1;
const positional = argv.filter(
  (arg, i) => !arg.startsWith('--') && i !== portValueIndex
);

const db = positional[0] ?? 'demo';
const port = flagPort ?? positional[1];

const token = getToken({ db, sub: 'demo-user', scope });

console.log(token);

if (port) {
  const base = `http://localhost:${port}/${token}/ogc`;
  console.log('');
  console.log(`Landing page: ${base}`);
  console.log(`Collections:  ${base}/collections`);
}

console.error(`\n(tenant: ${db}, scope: ${scope}, expires in ${TOKEN_TTL})`);
if (scope === 'rw') {
  console.error(
    'Read-write: do not paste this into a GIS client that saves URLs into a project file.'
  );
}
