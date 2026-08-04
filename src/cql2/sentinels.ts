import { Cql2Error } from '@/cql2/errors';

/**
 * Sentinels are the mechanism the whole translator rests on.
 *
 * Literals and property names are replaced with inert placeholders *before*
 * `cql2-rs` sees them, and resolved *after* it has produced SQL. That buys
 * three things at once:
 *
 *   1. `to_ducksql()` inlines literals into the SQL string. Because every
 *      literal is a sentinel by then, we can swap each one for a `?` and bind
 *      the real value — turning an inlined-literal translation into a
 *      parameterised one without reimplementing the translation.
 *   2. The upstream text parser truncates string literals at an escaped `''`
 *      (`'O''Brien'` becomes `'O'`). It never sees a quote to choke on.
 *   3. The upstream text parser splits identifiers on the `NOT` keyword
 *      (`note = 1` becomes `NOT (e = 1)`). It never sees such an identifier.
 */

export const STRING_PREFIX = '__CQL2STR';
export const IDENT_PREFIX = 'cql2id';

export const stringSentinel = (index: number): string => `${STRING_PREFIX}${index}__`;
export const identSentinel = (index: number): string => `${IDENT_PREFIX}${index}`;

/** Matches either sentinel form in generated SQL, quoted or bare. */
export const SENTINEL_PATTERN = /'__CQL2STR(\d+)__'|__CQL2STR(\d+)__|\bcql2id(\d+)\b/g;

export interface Sentinels {
  strings: string[];
  properties: string[];
}

export function createSentinels(): Sentinels {
  return { strings: [], properties: [] };
}

export function addString(sentinels: Sentinels, value: string): string {
  const token = stringSentinel(sentinels.strings.length);
  sentinels.strings.push(value);
  return token;
}

/** The CQL2 unbounded-interval marker. Resolved during the AST rewrite pass. */
export const UNBOUNDED = '..';

/** The index a string sentinel refers to, or null if this is not one. */
export function readStringSentinel(value: string): number | null {
  const match = /^__CQL2STR(\d+)__$/.exec(value);
  return match ? Number(match[1]) : null;
}

export function unboundedValue(boundIndex: number): string {
  return boundIndex === 0 ? '-infinity' : 'infinity';
}

export function addProperty(sentinels: Sentinels, name: string): string {
  const token = identSentinel(sentinels.properties.length);
  sentinels.properties.push(name);
  return token;
}

/**
 * A sentinel already present in the input would be resolved as though we had
 * put it there, letting a caller inject an arbitrary identifier or literal.
 */
export function rejectExistingSentinels(text: string): void {
  if (text.includes(STRING_PREFIX) || /\bcql2id\d/.test(text)) {
    throw new Cql2Error('PARSE_ERROR', 'Filter contains a reserved token');
  }
}
