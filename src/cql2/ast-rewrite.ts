import { Cql2Error } from '@/cql2/errors';
import { readStringSentinel, UNBOUNDED, unboundedValue, type Sentinels } from '@/cql2/sentinels';

/**
 * A rewrite pass over the CQL2-JSON AST, run between parsing and translation.
 *
 * Correcting the AST is strictly better than correcting the SQL afterwards: the
 * structure is unambiguous, so there is no pattern-matching on generated text,
 * and whatever we produce is translated by `cql2-rs` itself rather than by us.
 *
 * It does three things:
 *
 *   1. Rejects operations outside the supported set, so an unsupported filter is
 *      a clean `UNSUPPORTED_OP` naming the operation rather than a database error.
 *   2. Rewrites `a_equals` into the containment check CQL2 actually specifies.
 *      Upstream translates it to `x = ARRAY[...]`, which DuckDB evaluates
 *      order-sensitively, so `['eu','capital']` fails to match `['capital','eu']`.
 *   3. Resolves unbounded interval bounds. `to_ducksql()` passes `'..'` into a
 *      timestamp cast, which DuckDB rejects; which infinity it means depends on
 *      the bound's position, which is plain here and unrecoverable from the SQL.
 */

/**
 * Every operation `cql2-rs` will translate to DuckDB SQL, verified by calling
 * `to_ducksql()` on each. Anything absent is rejected rather than passed through
 * and allowed to fail later as a SQL error.
 */
export const SUPPORTED_OPS: ReadonlySet<string> = new Set([
  // logical
  'and',
  'or',
  'not',
  // comparison
  '=',
  '<>',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'like',
  'between',
  'in',
  'isNull',
  // case and accent folding
  'casei',
  'accenti',
  // arithmetic
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  // spatial
  's_intersects',
  's_equals',
  's_disjoint',
  's_touches',
  's_within',
  's_overlaps',
  's_crosses',
  's_contains',
  'bbox',
  // temporal — all fifteen Allen relations
  't_after',
  't_before',
  't_meets',
  't_metby',
  't_equals',
  't_disjoint',
  't_intersects',
  't_contains',
  't_during',
  't_starts',
  't_startedby',
  't_finishes',
  't_finishedby',
  't_overlaps',
  't_overlappedby',
  // arrays
  'a_contains',
  'a_containedby',
  'a_overlaps',
  'a_equals',
]);

export interface RewriteOptions {
  sentinels: Sentinels;
  /** Operation names to accept beyond `SUPPORTED_OPS`. */
  additionalOps?: readonly string[];
  maxDepth: number;
}

type Node = unknown;

const isRecord = (node: Node): node is Record<string, unknown> =>
  typeof node === 'object' && node !== null && !Array.isArray(node);

export function rewriteAst(root: Node, options: RewriteOptions): Node {
  return visit(root, options, 0);
}

function visit(node: Node, options: RewriteOptions, depth: number): Node {
  if (depth > options.maxDepth) {
    throw new Cql2Error('PARSE_ERROR', `Filter nests deeper than ${options.maxDepth} levels`);
  }

  if (Array.isArray(node)) return node.map((child) => visit(child, options, depth + 1));
  if (!isRecord(node)) return node;

  // An interval's bounds are the only place a sentinel's recorded value is
  // reinterpreted, and position is what decides it.
  if (Array.isArray(node.interval)) {
    resolveIntervalBounds(node.interval, options.sentinels);
    return node;
  }

  // A geometry is structural throughout; nothing inside it is rewritten.
  if (typeof node.type === 'string' && !('op' in node)) return node;

  if (typeof node.op !== 'string') return node;

  const op = node.op;
  if (!SUPPORTED_OPS.has(op) && !options.additionalOps?.includes(op)) {
    throw new Cql2Error('UNSUPPORTED_OP', `Unsupported operation: ${op}`, op);
  }

  const args = Array.isArray(node.args)
    ? node.args.map((arg) => visit(arg, options, depth + 1))
    : [];

  if (op === 'a_equals') return setEquality(args, op);

  return { op, args };
}

/**
 * CQL2 defines A_EQUALS as set equality. Expressed as containment in both
 * directions, which upstream already translates correctly to `list_has_all`.
 */
function setEquality(args: Node[], op: string): Node {
  if (args.length !== 2) {
    throw new Cql2Error('PARSE_ERROR', `Operation ${op} expects 2 arguments, got ${args.length}`);
  }
  const [left, right] = args;
  return {
    op: 'and',
    args: [
      { op: 'a_contains', args: [left, right] },
      { op: 'a_contains', args: [right, left] },
    ],
  };
}

function resolveIntervalBounds(interval: unknown[], sentinels: Sentinels): void {
  interval.forEach((bound, index) => {
    if (typeof bound !== 'string') return;

    const sentinelIndex = readStringSentinel(bound);
    if (sentinelIndex === null) return;

    if (sentinels.strings[sentinelIndex] === UNBOUNDED) {
      // Rewriting the recorded value keeps the AST untouched — the sentinel
      // still stands in the same place, it just resolves to an infinity.
      sentinels.strings[sentinelIndex] = unboundedValue(index);
    }
  });
}
