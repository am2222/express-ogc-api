import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { Cql2ToSql } from '../../src/cql2/cql2-to-sql.js';

import type { FilterLang } from '../../src/cql2/cql2-to-sql.js';

/**
 * A fixture chosen so that every operation the registry emits can be told apart
 * by which rows come back — a mapping that compiles but means the wrong thing
 * fails here, where a string assertion would pass.
 *
 * Timestamps are positioned relative to the interval [2020-01-01, 2021-01-01]:
 * one before, one exactly at the start, one strictly inside, one exactly at the
 * end, one after. That is enough to distinguish all fifteen Allen relations.
 */
export const REFERENCE_INTERVAL = ['2020-01-01T00:00:00Z', '2021-01-01T00:00:00Z'] as const;

export async function createFixture(): Promise<{
  instance: DuckDBInstance;
  db: DuckDBConnection;
}> {
  const instance = await DuckDBInstance.create(':memory:');
  const db = await instance.connect();
  // Installed once in test/global-setup.ts, so this only has to load it.
  await db.run('LOAD spatial;');

  await db.run(`
    CREATE TABLE places (
      id       INTEGER,
      name     VARCHAR,
      pop      INTEGER,
      -- Named to exercise the upstream NOT-boundary bug: the text grammar reads
      -- "note = 5" as "NOT (e = 5)", against a column that does not exist.
      note     INTEGER,
      ts       TIMESTAMP WITH TIME ZONE,
      day      DATE,
      tags     VARCHAR[],
      geom     GEOMETRY
    );
  `);

  await db.run(`
    INSERT INTO places VALUES
      (1, 'London',   9002488, 5,    '2019-01-01T00:00:00Z', DATE '2019-01-01', ['capital','eu'],   ST_Point(-0.1276, 51.5074)),
      (2, 'Paris',    2161000, 5,    '2020-01-01T00:00:00Z', DATE '2020-01-01', ['capital','eu'],   ST_Point(2.3522, 48.8566)),
      (3, 'Zürich',    421878, 1,    '2020-06-01T00:00:00Z', DATE '2020-06-01', ['finance'],        ST_Point(8.5417, 47.3769)),
      (4, 'O''Brien',       7, 2,    '2021-01-01T00:00:00Z', DATE '2021-01-01', ['odd','eu'],       ST_Point(1.0, 50.0)),
      (5, 'Tokyo',   13960000, 3,    '2022-01-01T00:00:00Z', DATE '2022-01-01', ['capital','asia'], ST_Point(139.6917, 35.6895)),
      (6, NULL,          NULL, NULL, NULL,                   NULL,              NULL,               NULL);
  `);

  return { instance, db };
}

/** Translate a filter, run it against the fixture, and return matching ids. */
export async function idsMatching(
  db: DuckDBConnection,
  filter: string,
  filterLang: FilterLang = 'cql2-text'
): Promise<number[]> {
  const translator = new Cql2ToSql();
  const { sql, params } = translator.toSql(filter, filterLang);

  const reader = await db.runAndReadAll(
    `SELECT id FROM places WHERE ${sql} ORDER BY id`,
    params as never[]
  );

  return reader.getRowObjectsJS().map((row) => Number(row.id));
}

/** Run raw SQL against the fixture — used by the differential test. */
export async function idsMatchingSql(db: DuckDBConnection, sql: string): Promise<number[]> {
  const reader = await db.runAndReadAll(`SELECT id FROM places WHERE ${sql} ORDER BY id`);
  return reader.getRowObjectsJS().map((row) => Number(row.id));
}
