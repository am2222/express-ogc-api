import { expect } from 'vitest';
import { Cql2ToSql } from '../../src/cql2/cql2-to-sql.js';
import type { Cql2ToSqlOptions, Sql } from '../../src/cql2/cql2-to-sql.js';

export function translate(filter: string, options: Cql2ToSqlOptions = {}): Sql {
  return new Cql2ToSql(options).toSql(filter);
}

export function translateJson(filter: unknown, options: Cql2ToSqlOptions = {}): Sql {
  const text = typeof filter === 'string' ? filter : JSON.stringify(filter);
  return new Cql2ToSql(options).toSql(text, 'cql2-json');
}

/**
 * The injection invariant, asserted mechanically rather than by eye: no value
 * that came from the filter may appear in the SQL string. Everything
 * user-supplied is a bound parameter; only identifiers and fixed tokens are
 * ever concatenated.
 */
export function expectNoValueInSql(result: Sql): void {
  for (const param of result.params) {
    if (typeof param === 'string' && param.length > 0) {
      expect(result.sql).not.toContain(param);
    }
  }
}

/** Run `fn` and return the Cql2Error code it throws. */
export function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? 'NOT_A_CQL2_ERROR';
  }
  throw new Error('expected the call to throw, but it returned');
}
