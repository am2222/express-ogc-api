import { Cql2Error } from '@/cql2/errors';
import { getCql2 } from '@/cql2/wasm';
import { scanText } from '@/cql2/scanner';
import { scanJson } from '@/cql2/json-scanner';
import { SENTINEL_PATTERN, type Sentinels } from '@/cql2/sentinels';
import { duckdbPatches, type SqlPatch } from '@/cql2/duckdb-patches';
import { rewriteAst } from '@/cql2/ast-rewrite';

export type FilterLang = 'cql2-text' | 'cql2-json';

/** A SQL fragment and the values bound to its `?` placeholders, in order. */
export interface Sql {
  sql: string;
  params: unknown[];
}

export interface Cql2ToSqlOptions {
  /**
   * Property names the filter may reference — normally a collection's
   * queryables. Anything else is rejected with `UNKNOWN_PROPERTY` before it can
   * reach SQL. Omit to allow any property.
   */
  allowedProperties?: string[];
  /** Corrections applied to the generated SQL. Defaults to `duckdbPatches`. */
  patches?: SqlPatch[];
  /** Override identifier quoting for a non-DuckDB target. */
  quoteIdentifier?: (name: string) => string;
  /** Operation names to accept beyond the verified supported set. */
  additionalOps?: readonly string[];
  /** Guards against a hostile filter producing a pathological query. */
  maxParams?: number;
  maxLength?: number;
  maxDepth?: number;
}

const DEFAULT_MAX_PARAMS = 512;
const DEFAULT_MAX_LENGTH = 8192;
const DEFAULT_MAX_DEPTH = 64;

const quoteDuckDbIdentifier = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * Translates CQL2 into parameterised SQL.
 *
 * Both the parse and the SQL generation come from `cql2-rs`
 * (`Expr::to_ducksql`, via WebAssembly) — the same engine behind the official
 * playground. This class contributes the three things that translation does not
 * do on its own:
 *
 *   - **Bound parameters.** `to_ducksql()` inlines literals. Because every
 *     literal is a sentinel by the time it reaches the parser, each one is
 *     swapped for a `?` and its value bound.
 *   - **Identifier control.** Property names are checked against the allowlist
 *     and quoted, so an unknown queryable is a 400 rather than a database error.
 *   - **Corrections.** A short, documented patch list for constructs upstream
 *     renders as SQL DuckDB will not accept.
 *
 * Instances are stateless and safe to reuse across requests.
 */
export class Cql2ToSql {
  private readonly allowedProperties: Set<string> | undefined;
  private readonly patches: SqlPatch[];
  private readonly quoteIdentifier: (name: string) => string;
  private readonly additionalOps: readonly string[] | undefined;
  private readonly maxParams: number;
  private readonly maxLength: number;
  private readonly maxDepth: number;

  constructor(options: Cql2ToSqlOptions = {}) {
    this.allowedProperties = options.allowedProperties
      ? new Set(options.allowedProperties)
      : undefined;
    this.patches = options.patches ?? duckdbPatches;
    this.quoteIdentifier = options.quoteIdentifier ?? quoteDuckDbIdentifier;
    this.additionalOps = options.additionalOps;
    this.maxParams = options.maxParams ?? DEFAULT_MAX_PARAMS;
    this.maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  /** Translate a filter into a SQL boolean expression and its bound values. */
  toSql(filter: string, filterLang: FilterLang = 'cql2-text'): Sql {
    if (filter.length > this.maxLength) {
      throw new Cql2Error('PARSE_ERROR', `Filter is longer than ${this.maxLength} characters`);
    }

    const scanned = filterLang === 'cql2-json' ? scanJson(filter) : scanText(filter);
    const translated = this.translate(scanned.rewritten, filterLang, scanned);
    const patched = this.patches.reduce((sql, patch) => patch.apply(sql), translated);
    const result = this.resolveSentinels(patched, scanned);

    if (result.params.length > this.maxParams) {
      throw new Cql2Error('PARSE_ERROR', `Filter binds more than ${this.maxParams} values`);
    }

    return result;
  }

  /**
   * Parse, correct the AST, then let `cql2-rs` translate what we hand back.
   *
   * The round trip through CQL2-JSON is what keeps this thin: corrections are
   * made against unambiguous structure, and the SQL is still generated entirely
   * by upstream — we never assemble SQL, and never pattern-match on it beyond
   * the one remaining patch.
   */
  private translate(rewritten: string, filterLang: FilterLang, sentinels: Sentinels): string {
    const cql2 = getCql2();

    let ast: unknown;
    try {
      const parsed =
        filterLang === 'cql2-json' ? cql2.parseJson(rewritten) : cql2.parseText(rewritten);
      // `to_json()` returns a JSON string despite being typed `any`.
      ast = JSON.parse(parsed.to_json());
    } catch (err) {
      throw new Cql2Error('PARSE_ERROR', `Could not parse ${filterLang} filter`, String(err));
    }

    const corrected = rewriteAst(ast, {
      sentinels,
      additionalOps: this.additionalOps,
      maxDepth: this.maxDepth,
    });

    try {
      return cql2.parseJson(JSON.stringify(corrected)).to_ducksql();
    } catch (err) {
      throw new Cql2Error('UNSUPPORTED_OP', 'Filter cannot be translated to SQL', String(err));
    }
  }

  /**
   * Replace each sentinel in the generated SQL: a literal becomes a `?` with
   * its value bound, a property becomes a validated, quoted identifier.
   *
   * Parameters are collected in order of appearance in the SQL, which is not
   * necessarily the order they appeared in the filter — `to_ducksql()` reorders
   * some operands (`T_AFTER(a, b)` becomes `b < a`).
   */
  private resolveSentinels(sql: string, sentinels: Sentinels): Sql {
    const params: unknown[] = [];

    const resolved = sql.replace(
      SENTINEL_PATTERN,
      (match, quotedString?: string, bareString?: string, property?: string) => {
        const stringIndex = quotedString ?? bareString;

        if (stringIndex !== undefined) {
          const value = sentinels.strings[Number(stringIndex)];
          if (value === undefined) {
            throw new Cql2Error('PARSE_ERROR', 'Filter references an unknown literal');
          }
          params.push(value);
          return '?';
        }

        if (property !== undefined) {
          const name = sentinels.properties[Number(property)];
          if (name === undefined) {
            throw new Cql2Error('PARSE_ERROR', 'Filter references an unknown property');
          }
          return this.identifier(name);
        }

        return match;
      }
    );

    return { sql: resolved, params };
  }

  private identifier(name: string): string {
    if (this.allowedProperties && !this.allowedProperties.has(name)) {
      throw new Cql2Error('UNKNOWN_PROPERTY', `Unknown property: ${name}`, name);
    }
    // A NUL byte truncates the identifier inside the database driver.
    if (name.includes('\0')) {
      throw new Cql2Error('UNKNOWN_PROPERTY', 'Property name contains a NUL byte');
    }
    return this.quoteIdentifier(name);
  }
}
