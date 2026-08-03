/**
 * Mints a demo JWT for the server in `serve-demo.ts`.
 *
 *   npx tsx examples/mint-token.ts            # tenant `demo`
 *   npx tsx examples/mint-token.ts demo       # same, explicit
 *   npx tsx examples/mint-token.ts demo 3005  # also print ready-to-use URLs
 *
 * Set DEMO_JWT_SECRET to the same value the server uses, or leave it unset on
 * both sides to use the demo default.
 */

import { getToken, TOKEN_TTL } from './demo-jwt.js';

const db = process.argv[2] ?? 'demo';
const port = process.argv[3];

const token = getToken({ db, sub: 'demo-user' });

console.log(token);

if (port) {
  const base = `http://localhost:${port}/${token}/ogc`;
  console.log('');
  console.log(`Landing page: ${base}`);
  console.log(`Collections:  ${base}/collections`);
}

console.error(`\n(tenant: ${db}, expires in ${TOKEN_TTL})`);
