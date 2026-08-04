import { describe, it, expect } from 'vitest';
import { Cql2ToSql, duckdbPatches, Cql2Error } from '../../src/index.js';

/**
 * The examples in README.md, executed. Documentation that is not run rots; if
 * one of these fails, the README is wrong and needs updating with it.
 */
describe('README — CQL2 Filtering', () => {
  it('produces the documented SQL and parameters', () => {
    const translator = new Cql2ToSql();

    const result = translator.toSql("casei(name) = casei('bob')");

    expect(result.sql).toBe('lower("name") = lower(?)');
    expect(result.params).toEqual(['bob']);
  });

  it('rejects a property outside allowedProperties', () => {
    const translator = new Cql2ToSql({ allowedProperties: ['name', 'pop', 'geom'] });

    try {
      translator.toSql('secret = 1');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Cql2Error);
      expect((err as Cql2Error).code).toBe('UNKNOWN_PROPERTY');
    }
  });

  it('extends the patch list', () => {
    const translator = new Cql2ToSql({
      patches: [
        ...duckdbPatches,
        {
          name: 'mine',
          reason: 'target a custom spatial index',
          apply: (sql: string) => sql.replace(/\bst_intersects\(/gi, 'ST_Intersects_Extent('),
        },
      ],
    });

    expect(translator.toSql('S_INTERSECTS(geom, POINT(1 2))').sql).toContain(
      'ST_Intersects_Extent('
    );
  });

  it('binds string values but leaves numbers inline, as documented', () => {
    const result = new Cql2ToSql().toSql("name = 'bob' AND pop > 1000");

    expect(result.params).toEqual(['bob']);
    expect(result.sql).toContain('1000');
    expect(result.sql).not.toContain('bob');
  });
});
