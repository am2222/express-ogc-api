import { describe, it, expect } from 'vitest';
import { scanText } from '../../src/cql2/scanner.js';
import { scanJson } from '../../src/cql2/json-scanner.js';
import { Cql2Error } from '../../src/cql2/errors.js';

describe('scanText — string literals', () => {
  it('keeps an escaped quote, which the upstream parser truncates', () => {
    // Upstream bug: `name = 'O''Brien'` parses to `name = 'O'`, silently.
    expect(scanText("name = 'O''Brien'").strings).toEqual(["O'Brien"]);
  });

  it('preserves a quote-heavy value verbatim', () => {
    expect(scanText("city = 'x''; DROP TABLE t; --'").strings).toEqual([
      "x'; DROP TABLE t; --",
    ]);
  });

  it('keeps multiple literals in order', () => {
    expect(scanText("a = 'a''b' AND b LIKE 'C%''s'").strings).toEqual(["a'b", "C%'s"]);
  });

  it('handles an empty literal', () => {
    expect(scanText("a = ''").strings).toEqual(['']);
  });

  it('handles a literal that is only an escaped quote', () => {
    expect(scanText("a = ''''").strings).toEqual(["'"]);
  });

  it('removes literal content from the text handed to the parser', () => {
    expect(scanText("name = 'O''Brien'").rewritten).not.toContain('Brien');
  });

  it('rejects an unterminated literal', () => {
    expect(() => scanText("name = 'unterminated")).toThrow(Cql2Error);
    expect(() => scanText("name = 'unterminated")).toThrow(/unterminated/i);
  });
});

describe('scanText — identifiers', () => {
  it('replaces a property whose name starts with NOT', () => {
    // Upstream bug: `note = 1` parses to `NOT (e = 1)`, silently.
    expect(scanText('note = 1').properties).toEqual(['note']);
    expect(scanText('notes = 1').properties).toEqual(['notes']);
    expect(scanText('note = 1').rewritten).not.toMatch(/\bnote\b/);
  });

  it('leaves keywords alone, case-insensitively', () => {
    const { rewritten } = scanText("a = 1 AND b = 2 or c IS NULL and d NOT LIKE 'x'");

    for (const keyword of ['AND', 'or', 'IS', 'NULL', 'and', 'NOT', 'LIKE']) {
      expect(rewritten).toContain(keyword);
    }
  });

  it('treats TRUE and FALSE as keywords, not properties', () => {
    expect(scanText('a = TRUE').properties).toEqual(['a']);
  });

  it('treats a word followed by "(" as a function, not a property', () => {
    expect(scanText('S_INTERSECTS(geom, POINT(1 2))').properties).toEqual(['geom']);
  });

  it('treats a function name followed by whitespace then "(" as a function', () => {
    expect(scanText("casei (name) = casei ('bob')").properties).toEqual(['name']);
  });

  it('keeps a dotted property as one identifier', () => {
    expect(scanText('a.b = 1').properties).toEqual(['a.b']);
  });

  it('does not treat a number as an identifier', () => {
    expect(scanText('a = 1.5').properties).toEqual(['a']);
  });
});

describe('scanText — sentinel collision', () => {
  it('rejects input already containing a string sentinel', () => {
    expect(() => scanText("a = '__CQL2STR0__'")).toThrow(Cql2Error);
  });

  it('rejects input already containing an identifier sentinel', () => {
    expect(() => scanText('cql2id0 = 1')).toThrow(Cql2Error);
  });
});

describe('scanJson', () => {
  const scanned = (filter: unknown) => scanJson(JSON.stringify(filter));

  it('captures a string value and a property name', () => {
    const result = scanned({ op: '=', args: [{ property: 'name' }, "O'Brien"] });

    expect(result.strings).toEqual(["O'Brien"]);
    expect(result.properties).toEqual(['name']);
  });

  it('leaves a geometry untouched — its type and coordinates are structural', () => {
    const result = scanned({
      op: 's_intersects',
      args: [{ property: 'geom' }, { type: 'Point', coordinates: [1, 2] }],
    });

    expect(result.strings).toEqual([]);
    expect(JSON.parse(result.rewritten).args[1]).toEqual({ type: 'Point', coordinates: [1, 2] });
  });

  it('captures timestamp and date values', () => {
    expect(scanned({ op: 't_after', args: [{ property: 'ts' }, { timestamp: '2020-01-01T00:00:00Z' }] }).strings).toEqual(
      ['2020-01-01T00:00:00Z']
    );
    expect(scanned({ op: 't_after', args: [{ property: 'd' }, { date: '2020-01-01' }] }).strings).toEqual(
      ['2020-01-01']
    );
  });

  it('records interval bounds verbatim — the AST rewrite resolves ".."', () => {
    expect(
      scanned({ op: 't_intersects', args: [{ property: 'ts' }, { interval: ['..', '..'] }] }).strings
    ).toEqual(['..', '..']);
  });

  it('captures values inside a list', () => {
    expect(scanned({ op: 'in', args: [{ property: 'id' }, ['a', 'b']] }).strings).toEqual(['a', 'b']);
  });

  it('does not capture the op name', () => {
    expect(scanned({ op: '=', args: [{ property: 'a' }, 1] }).strings).toEqual([]);
  });

  it('rejects malformed JSON', () => {
    expect(() => scanJson('{not json')).toThrow(Cql2Error);
  });

  it('rejects a reserved sentinel token in the input', () => {
    expect(() => scanned({ op: '=', args: [{ property: 'a' }, '__CQL2STR0__'] })).toThrow(Cql2Error);
  });
});
