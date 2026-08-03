import { describe, it, expect } from 'vitest';
import { Cql2Error } from '../../src/cql2/errors.js';
import { duckdbPatches } from '../../src/cql2/duckdb-patches.js';
import { translate, translateJson, expectNoValueInSql, codeOf } from './helpers.js';

/**
 * These cover what this package contributes on top of `to_ducksql()`: bound
 * parameters, identifier control, and the patch list. The *meaning* of each
 * operation is covered by execute.test.ts, which runs the SQL — asserting exact
 * SQL strings here would pin upstream's formatting rather than our behaviour.
 */

describe('parameter binding', () => {
  it('binds a string literal instead of inlining it', () => {
    const result = translate("name = 'bob'");

    expect(result.sql).not.toContain('bob');
    expect(result.sql).toContain('?');
    expect(result.params).toEqual(['bob']);
  });

  it('binds a value containing quotes, which upstream would inline', () => {
    const result = translate("name = 'x''; DROP TABLE places; --'");

    expect(result.params).toEqual(["x'; DROP TABLE places; --"]);
    expectNoValueInSql(result);
  });

  it('binds one parameter per placeholder', () => {
    const result = translate("name = 'a' AND note = 'b' AND other LIKE 'c'");

    expect(result.sql.match(/\?/g)).toHaveLength(result.params.length);
  });

  it('binds parameters in order of appearance in the SQL, not the filter', () => {
    // to_ducksql() reorders this to `CAST(? ...) < ts`, so ordering has to come
    // from the generated SQL rather than from the filter text.
    const result = translate("T_AFTER(ts, TIMESTAMP('2020-01-01T00:00:00Z'))");

    expect(result.params).toEqual(['2020-01-01T00:00:00Z']);
  });

  it('binds each occurrence separately when a value is used twice', () => {
    const result = translateJson({ op: 'a_equals', args: [{ property: 'tags' }, ['eu']] });

    expect(result.sql.match(/\?/g)).toHaveLength(result.params.length);
    expect(result.params).toEqual(['eu', 'eu']);
  });

  it('leaves numeric literals inline — they cannot carry injection', () => {
    const result = translate('pop > 1000');

    expect(result.params).toEqual([]);
    expect(result.sql).toContain('1000');
  });
});

describe('identifiers', () => {
  it('quotes a property name', () => {
    expect(translate('name = 1').sql).toContain('"name"');
  });

  it('quotes a property the upstream parser would have mangled', () => {
    // `note` is split into `NOT e` by the upstream grammar.
    const result = translate('note = 1');

    expect(result.sql).toContain('"note"');
    expect(result.sql).not.toMatch(/\bNOT\b/i);
  });

  it('doubles an embedded double quote', () => {
    expect(translateJson({ op: '=', args: [{ property: 'we"ird' }, 1] }).sql).toContain(
      '"we""ird"'
    );
  });

  it('rejects an unlisted property', () => {
    expect(codeOf(() => translate('secret = 1', { allowedProperties: ['name'] }))).toBe(
      'UNKNOWN_PROPERTY'
    );
  });

  it('accepts a listed property', () => {
    expect(() => translate('name = 1', { allowedProperties: ['name'] })).not.toThrow();
  });

  it('names the offending property', () => {
    try {
      translate('secret = 1', { allowedProperties: ['name'] });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Cql2Error);
      expect((err as Cql2Error).message).toContain('secret');
    }
  });

  it('rejects a NUL byte in a property name', () => {
    expect(codeOf(() => translateJson({ op: '=', args: [{ property: 'a\0b' }, 1] }))).toBe(
      'UNKNOWN_PROPERTY'
    );
  });

  it('supports a non-DuckDB quoting rule', () => {
    const result = translate('name = 1', { quoteIdentifier: (n) => `[${n}]` });

    expect(result.sql).toContain('[name]');
  });
});

describe('patches', () => {
  const patch = (name: string) => duckdbPatches.find((p) => p.name === name);

  it('rewrites bbox() to ST_MakeEnvelope', () => {
    const result = translate('S_INTERSECTS(geom, BBOX(-80, 43, -79, 44))');

    expect(result.sql).toContain('ST_MakeEnvelope(');
    expect(result.sql).not.toMatch(/\bbbox\s*\(/i);
  });

  it('does not rewrite a name merely containing bbox', () => {
    expect(patch('bbox')?.apply('st_bbox(x)')).toBe('st_bbox(x)');
    expect(patch('bbox')?.apply('bbox_id = 1')).toBe('bbox_id = 1');
  });

  it('can be replaced wholesale', () => {
    const result = translate('name = 1', {
      patches: [{ name: 'none', reason: 'test', apply: () => 'REPLACED' }],
    });

    expect(result.sql).toBe('REPLACED');
  });
});

describe('limits and rejections', () => {
  it('rejects a filter longer than maxLength', () => {
    expect(codeOf(() => translate('name = 1', { maxLength: 3 }))).toBe('PARSE_ERROR');
  });

  it('rejects more bound parameters than maxParams', () => {
    const many = `name IN (${Array.from({ length: 20 }, (_, i) => `'v${i}'`).join(', ')})`;

    expect(codeOf(() => translate(many, { maxParams: 5 }))).toBe('PARSE_ERROR');
  });

  it('rejects malformed cql2-json', () => {
    expect(codeOf(() => translateJson('{not json'))).toBe('PARSE_ERROR');
  });

  it('rejects a filter containing a reserved sentinel token', () => {
    expect(codeOf(() => translate("name = '__CQL2STR0__'"))).toBe('PARSE_ERROR');
    expect(codeOf(() => translate('cql2id0 = 1'))).toBe('PARSE_ERROR');
  });

  it('rejects an unterminated string literal', () => {
    expect(codeOf(() => translate("name = 'oops"))).toBe('PARSE_ERROR');
  });
});
