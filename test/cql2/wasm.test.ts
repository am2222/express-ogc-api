import { describe, it, expect } from 'vitest';
import { getCql2 } from '../../src/cql2/wasm.js';

describe('cql2-wasm loader', () => {
  it('returns a module exposing the parser entry points', () => {
    const cql2 = getCql2();

    expect(typeof cql2.parseText).toBe('function');
    expect(typeof cql2.parseJson).toBe('function');
  });

  it('is idempotent — initialising twice does not throw', () => {
    expect(() => getCql2()).not.toThrow();
    expect(() => getCql2()).not.toThrow();
  });

  it('parses text into the CQL2-JSON AST', () => {
    const ast = JSON.parse(getCql2().parseText('a = 1').to_json());

    expect(ast).toEqual({ op: '=', args: [{ property: 'a' }, 1] });
  });

  // Pins verified fact #2 from the plan. `to_json()` is typed `any` and looks
  // like it returns an object; it returns a JSON string. If a future release
  // changes that, this test tells us before the walker silently sees a string.
  it('to_json() returns a JSON string, not an object', () => {
    expect(typeof getCql2().parseText('a = 1').to_json()).toBe('string');
  });
});
