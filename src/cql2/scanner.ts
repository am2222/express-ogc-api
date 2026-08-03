import { Cql2Error } from '@/cql2/errors';
import {
  addProperty,
  addString,
  createSentinels,
  rejectExistingSentinels,
  type Sentinels,
} from '@/cql2/sentinels';

/**
 * Rewrites CQL2 *text* so that every string literal and every property name is
 * a sentinel before the upstream parser sees it. See `sentinels.ts` for why.
 */

export interface ScanResult extends Sentinels {
  /** Text safe to hand to the upstream parser. */
  rewritten: string;
}

/** Words the grammar owns; anything else that is not a call is a property. */
const KEYWORDS = new Set([
  'and',
  'or',
  'not',
  'like',
  'in',
  'is',
  'null',
  'between',
  'true',
  'false',
]);

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_.]/;

export function scanText(text: string): ScanResult {
  rejectExistingSentinels(text);

  const sentinels = createSentinels();
  let rewritten = '';
  let i = 0;


  while (i < text.length) {
    const ch = text[i] as string;

    if (ch === "'") {
      i++;
      let value = '';
      for (;;) {
        if (i >= text.length) {
          throw new Cql2Error('PARSE_ERROR', 'Unterminated string literal in filter');
        }
        if (text[i] === "'") {
          // `''` is an escaped quote; a lone `'` closes the literal.
          if (text[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += text[i] as string;
        i++;
      }
      rewritten += `'${addString(sentinels, value)}'`;
      continue;
    }

    if (IDENT_START.test(ch)) {
      let word = '';
      while (i < text.length && IDENT_CHAR.test(text[i] as string)) {
        word += text[i] as string;
        i++;
      }

      // A word followed by `(` is a function — a predicate such as
      // S_INTERSECTS, or a constructor such as TIMESTAMP — not a property.
      let j = i;
      while (j < text.length && /\s/.test(text[j] as string)) j++;
      const isCall = text[j] === '(';

      rewritten += KEYWORDS.has(word.toLowerCase()) || isCall
        ? word
        : addProperty(sentinels, word);
      continue;
    }

    rewritten += ch;
    i++;
  }

  return { rewritten, ...sentinels };
}
