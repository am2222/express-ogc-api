import { DuckDBInstance } from '@duckdb/node-api';

/**
 * Install the `spatial` extension once, before any test worker starts.
 *
 * Test files run in parallel worker processes, and each one opens its own
 * DuckDB connection — but every DuckDB process on the machine shares a single
 * extension directory (`~/.duckdb/extensions/<version>/<platform>`). When that
 * directory is already warm, `INSTALL spatial` is a no-op and the sharing is
 * invisible. When it is cold — a fresh CI runner, or a fresh clone — several
 * workers would each start downloading the same 57MB extension into the same
 * directory at the same time, and a worker whose `LOAD` ran while the file was
 * not yet in place died with:
 *
 *   IO Error: Extension ".../spatial.duckdb_extension" not found.
 *   Install it first using "INSTALL spatial".
 *
 * That is why the failure only ever showed up on CI, and only intermittently:
 * one matrix job would fail while the other two passed on the same commit.
 *
 * Installing here — serially, in the main process, before the pool spawns —
 * means the extension is on disk by the time any worker looks for it. Workers
 * only `LOAD`, which reads the file and never writes it, so there is nothing
 * left to race over. It also means the download happens once per cold machine
 * instead of once per test file.
 */
export default async function setup(): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run('INSTALL spatial;');
  } finally {
    connection.disconnectSync();
  }
}
