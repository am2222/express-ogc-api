import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DuckDBConnection } from '@duckdb/node-api';
import { createFixture, idsMatching } from './fixture.js';

let db: DuckDBConnection;

beforeAll(async () => {
  ({ db } = await createFixture());
});

afterAll(() => {
  db.disconnectSync();
});

const ids = (filter: string) => idsMatching(db, filter);
const idsJson = (filter: unknown) => idsMatching(db, JSON.stringify(filter), 'cql2-json');

describe('comparison', () => {
  it('matches on equality', async () => {
    await expect(ids("name = 'Paris'")).resolves.toEqual([2]);
  });

  it('matches a value containing an apostrophe', async () => {
    // The whole point of the scanner: upstream truncates this to 'O'.
    await expect(ids("name = 'O''Brien'")).resolves.toEqual([4]);
  });

  it('matches on inequality', async () => {
    await expect(ids('pop > 9000000')).resolves.toEqual([1, 5]);
  });

  it('matches on BETWEEN', async () => {
    await expect(ids('pop BETWEEN 400000 AND 2200000')).resolves.toEqual([2, 3]);
  });

  it('matches on IN', async () => {
    await expect(ids('id IN (1, 3, 5)')).resolves.toEqual([1, 3, 5]);
  });

  it('matches on LIKE', async () => {
    await expect(ids("name LIKE 'T%'")).resolves.toEqual([5]);
  });

  it('matches IS NULL', async () => {
    await expect(ids('name IS NULL')).resolves.toEqual([6]);
  });

  it('combines with AND and OR', async () => {
    await expect(ids("pop > 1000000 AND (name = 'Paris' OR name = 'Tokyo')")).resolves.toEqual([
      2, 5,
    ]);
  });

  it('negates', async () => {
    await expect(ids("NOT (name = 'Paris')")).resolves.toEqual([1, 3, 4, 5]);
  });
});

describe('casei and accenti', () => {
  it('matches case-insensitively', async () => {
    await expect(ids("casei(name) = casei('PARIS')")).resolves.toEqual([2]);
  });

  it('matches ignoring accents', async () => {
    await expect(ids("accenti(name) = accenti('Zurich')")).resolves.toEqual([3]);
  });
});

describe('arithmetic', () => {
  it('evaluates arithmetic against a column', async () => {
    await expect(ids('pop / 2 > 4600000')).resolves.toEqual([5]);
  });

  it('handles a negative literal', async () => {
    await expect(ids('pop > -1')).resolves.toEqual([1, 2, 3, 4, 5]);
  });
});

describe('spatial', () => {
  const europe = 'BBOX(-10, 40, 10, 60)';

  it('S_INTERSECTS with a bbox', async () => {
    await expect(ids(`S_INTERSECTS(geom, ${europe})`)).resolves.toEqual([1, 2, 3, 4]);
  });

  it('S_WITHIN a bbox', async () => {
    await expect(ids(`S_WITHIN(geom, ${europe})`)).resolves.toEqual([1, 2, 3, 4]);
  });

  it('S_DISJOINT from a bbox', async () => {
    await expect(ids(`S_DISJOINT(geom, ${europe})`)).resolves.toEqual([5]);
  });

  it('S_EQUALS a point', async () => {
    await expect(ids('S_EQUALS(geom, POINT(1.0 50.0))')).resolves.toEqual([4]);
  });

  it('accepts GeoJSON through cql2-json', async () => {
    await expect(
      idsJson({
        op: 's_intersects',
        args: [
          { property: 'geom' },
          {
            type: 'Polygon',
            coordinates: [
              [
                [-10, 40],
                [10, 40],
                [10, 60],
                [-10, 60],
                [-10, 40],
              ],
            ],
          },
        ],
      })
    ).resolves.toEqual([1, 2, 3, 4]);
  });
});

describe('temporal — every Allen relation against the reference interval', () => {
  const I = "INTERVAL('2020-01-01T00:00:00Z','2021-01-01T00:00:00Z')";

  // ts values: 1=2019-01-01 (before), 2=2020-01-01 (at start),
  //            3=2020-06-01 (inside), 4=2021-01-01 (at end), 5=2022-01-01 (after)
  it.each([
    ['T_BEFORE', [1]],
    ['T_AFTER', [5]],
    ['T_DURING', [3]],
    ['T_INTERSECTS', [2, 3, 4]],
    ['T_DISJOINT', [1, 5]],
    ['T_STARTS', [2]],
    ['T_FINISHES', [4]],
    ['T_EQUALS', []],
  ])('%s', async (op, expected) => {
    await expect(ids(`${op}(ts, ${I})`)).resolves.toEqual(expected);
  });

  it('T_AFTER against a bare instant', async () => {
    await expect(ids("T_AFTER(ts, TIMESTAMP('2020-06-01T00:00:00Z'))")).resolves.toEqual([4, 5]);
  });

  it('T_BEFORE against a bare instant', async () => {
    await expect(ids("T_BEFORE(ts, TIMESTAMP('2020-06-01T00:00:00Z'))")).resolves.toEqual([1, 2]);
  });

  it('an unbounded interval end matches everything from the start onwards', async () => {
    await expect(
      idsJson({
        op: 't_intersects',
        args: [{ property: 'ts' }, { interval: ['2020-06-01T00:00:00Z', '..'] }],
      })
    ).resolves.toEqual([3, 4, 5]);
  });

  it('an unbounded interval start matches everything up to the end', async () => {
    await expect(
      idsJson({
        op: 't_intersects',
        args: [{ property: 'ts' }, { interval: ['..', '2020-06-01T00:00:00Z'] }],
      })
    ).resolves.toEqual([1, 2, 3]);
  });

  it('compares a DATE column', async () => {
    await expect(
      idsJson({ op: 't_after', args: [{ property: 'day' }, { date: '2020-06-01' }] })
    ).resolves.toEqual([4, 5]);
  });
});

describe('arrays', () => {
  it('a_contains', async () => {
    await expect(idsJson({ op: 'a_contains', args: [{ property: 'tags' }, ['eu']] })).resolves.toEqual([
      1, 2, 4,
    ]);
  });

  it('a_overlaps', async () => {
    await expect(
      idsJson({ op: 'a_overlaps', args: [{ property: 'tags' }, ['finance', 'asia']] })
    ).resolves.toEqual([3, 5]);
  });

  it('a_equals is order-insensitive', async () => {
    await expect(
      idsJson({ op: 'a_equals', args: [{ property: 'tags' }, ['eu', 'capital']] })
    ).resolves.toEqual([1, 2]);
  });

  it('a_containedby', async () => {
    await expect(
      idsJson({ op: 'a_containedby', args: [{ property: 'tags' }, ['capital', 'eu', 'asia']] })
    ).resolves.toEqual([1, 2, 5]);
  });
});
