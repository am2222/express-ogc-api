/**
 * Corrections applied to `to_ducksql()`'s output.
 *
 * `cql2-rs` renders a few constructs as SQL DuckDB does not accept. Each patch
 * here names the construct, what upstream emits, and why it has to change; each
 * one is covered by a test that fails if upstream stops needing it.
 */
export interface SqlPatch {
  name: string;
  reason: string;
  apply(sql: string): string;
}

export const duckdbPatches: SqlPatch[] = [
  {
    name: 'bbox',
    reason:
      'to_ducksql() emits bbox(minx, miny, maxx, maxy), which DuckDB does not define. ' +
      'ST_MakeEnvelope takes the same four arguments in the same order.',
    // Word-bounded so it cannot match st_bbox or a column named bbox_id.
    apply: (sql) => sql.replace(/\bbbox\s*\(/gi, 'ST_MakeEnvelope('),
  },
];
