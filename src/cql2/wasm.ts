import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as cql2 from 'cql2-wasm';

/**
 * `cql2-wasm` is published as a `web`-target wasm-bindgen build: it exposes
 * `initSync` plus a default async initialiser, and must be initialised before
 * any export is called. Under Node the synchronous path is simplest — we read
 * the `.wasm` file off disk ourselves rather than fetching it.
 *
 * Initialisation is lazy so that importing this package does not pay for it,
 * and guarded so repeated calls are free.
 */
let initialised = false;

export type Cql2Module = typeof cql2;

export function getCql2(): Cql2Module {
  if (!initialised) {
    const require = createRequire(import.meta.url);
    // The package has no `exports` map, so the deep path resolves directly.
    const wasmPath = require.resolve('cql2-wasm/cql2_wasm_bg.wasm');
    cql2.initSync({ module: readFileSync(wasmPath) });
    initialised = true;
  }
  return cql2;
}
