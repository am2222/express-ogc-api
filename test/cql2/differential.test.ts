import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DuckDBConnection } from '@duckdb/node-api';
import { createFixture, idsMatching, idsMatchingSql } from './fixture.js';
import { getCql2 } from '../../src/cql2/wasm.js';

/**
 * We now use `to_ducksql()` directly and patch its output, so this test's job is
 * to keep that patch list honest: for each patched construct, raw upstream SQL
 * must still be wrong. When upstream fixes one, the corresponding case fails and
 * the patch can be deleted rather than carried forever.
 *
 * The complement matters too — for everything we *don't* patch, our output must
 * agree with raw upstream, which is what proves the patches are narrow.
 */

interface Case {
  filter: string;
  reason: string;
}

/** Constructs we patch. Raw upstream must still fail or disagree. */
const PATCHED: Case[] = [
  {
    filter: 'S_INTERSECTS(geom, BBOX(-10, 40, 10, 60))',
    reason: 'upstream emits bbox(), which DuckDB does not define',
  },
  {
    filter: "name = 'O''Brien'",
    reason: 'upstream text parser truncates the literal at the escaped quote',
  },
  {
    filter: 'note = 5',
    reason: 'upstream splits the identifier on the NOT keyword, reading column "e"',
  },
];

/** Constructs we do not touch. Our output must match raw upstream exactly. */
const UNPATCHED = [
  "name = 'Paris'",
  'pop > 9000000',
  'pop BETWEEN 400000 AND 2200000',
  'id IN (1, 3, 5)',
  "name LIKE 'T%'",
  'name IS NULL',
  "pop > 1000000 AND (name = 'Paris' OR name = 'Tokyo')",
  "NOT (name = 'Paris')",
  "casei(name) = casei('PARIS')",
  "accenti(name) = accenti('Zurich')",
  'pop / 2 > 4600000',
  'S_EQUALS(geom, POINT(1.0 50.0))',
  "T_AFTER(ts, TIMESTAMP('2020-06-01T00:00:00Z'))",
  "T_BEFORE(ts, TIMESTAMP('2020-06-01T00:00:00Z'))",
];

let db: DuckDBConnection;

beforeAll(async () => {
  ({ db } = await createFixture());
});

afterAll(() => {
  db.disconnectSync();
});

/** Raw upstream translation, executed. `null` if it cannot run at all. */
async function rawUpstream(filter: string): Promise<number[] | null> {
  let sql: string;
  try {
    sql = getCql2().parseText(filter).to_ducksql();
  } catch {
    return null;
  }
  try {
    return await idsMatchingSql(db, sql);
  } catch {
    return null;
  }
}

describe('agreement with raw to_ducksql() where we do not patch', () => {
  it.each(UNPATCHED)('%s', async (filter) => {
    const ours = await idsMatching(db, filter);
    const theirs = await rawUpstream(filter);

    expect(theirs, `raw upstream could not evaluate: ${filter}`).not.toBeNull();
    expect(ours).toEqual(theirs);
  });
});

describe('corrections still earn their keep', () => {
  it.each(PATCHED)('$filter', async ({ filter, reason }) => {
    const ours = await idsMatching(db, filter);
    const theirs = await rawUpstream(filter);

    // If this fails, upstream has fixed it — remove the patch and this case
    // rather than keeping a workaround that no longer does anything.
    expect(theirs, `${filter} — expected still broken: ${reason}`).not.toEqual(ours);
  });

  it('a_equals: raw upstream is order-sensitive where CQL2 is not', async () => {
    // Corrected in the AST now, not in the SQL — the rewritten AST is handed
    // back to to_ducksql(), which generates list_has_all itself.
    const filter = JSON.stringify({
      op: 'a_equals',
      args: [{ property: 'tags' }, ['eu', 'capital']],
    });
    const ours = await idsMatching(db, filter, 'cql2-json');

    const rawSql = getCql2().parseJson(filter).to_ducksql();
    const theirs = await idsMatchingSql(db, rawSql).catch(() => null);

    expect(ours).toEqual([1, 2]);
    expect(theirs).not.toEqual(ours);
  });
});

describe('our translation succeeds across the whole corpus', () => {
  it.each([...UNPATCHED, ...PATCHED.map((c) => c.filter)])('%s', async (filter) => {
    await expect(idsMatching(db, filter)).resolves.toBeInstanceOf(Array);
  });
});
