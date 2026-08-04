import { Cql2Error } from '@/cql2/errors';
import {
  addProperty,
  addString,
  createSentinels,
  rejectExistingSentinels,
  type Sentinels,
} from '@/cql2/sentinels';

/**
 * The cql2-json counterpart of `scanText`. It walks the filter document and
 * replaces literals and property names with sentinels, so the JSON path gets
 * the same bound parameters and the same identifier control as the text path.
 *
 * Which strings are *data* is decided by key rather than by guessing: a
 * geometry's `"type": "Point"` and an operation's `"op": "="` are structural
 * and must survive untouched, while `property`, `timestamp`, `date`, `interval`
 * and bare strings in an argument list are values.
 */

export interface JsonScanResult extends Sentinels {
  rewritten: string;
}

export function scanJson(filter: string): JsonScanResult {
  rejectExistingSentinels(filter);

  let document: unknown;
  try {
    document = JSON.parse(filter);
  } catch (err) {
    throw new Cql2Error('PARSE_ERROR', 'Could not parse cql2-json filter', String(err));
  }

  const sentinels = createSentinels();
  const rewritten = JSON.stringify(walk(document, sentinels));

  return { rewritten, ...sentinels };
}

function walk(node: unknown, sentinels: Sentinels): unknown {
  // A bare string in an argument position is a literal value.
  if (typeof node === 'string') return addString(sentinels, node);

  if (Array.isArray(node)) return node.map((child) => walk(child, sentinels));

  if (node === null || typeof node !== 'object') return node;

  const source = node as Record<string, unknown>;

  // A geometry is structural throughout — `type` names the geometry and the
  // coordinates are numbers. Nothing inside it is a literal we bind.
  if (typeof source.type === 'string' && !('op' in source)) return node;

  if (typeof source.property === 'string') {
    return { ...source, property: addProperty(sentinels, source.property) };
  }

  if (typeof source.timestamp === 'string') {
    return { timestamp: addString(sentinels, source.timestamp) };
  }

  if (typeof source.date === 'string') {
    return { date: addString(sentinels, source.date) };
  }

  if (Array.isArray(source.interval)) {
    // Including `'..'`, which the AST rewrite pass resolves by position.
    return {
      interval: source.interval.map((end) =>
        typeof end === 'string' ? addString(sentinels, end) : end
      ),
    };
  }

  if (typeof source.op === 'string') {
    return { op: source.op, args: walk(source.args ?? [], sentinels) };
  }

  return node;
}
