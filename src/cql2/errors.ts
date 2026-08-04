export type Cql2ErrorCode =
  /** The filter could not be parsed, or exceeded a structural limit. */
  | 'PARSE_ERROR'
  /** A valid CQL2 operation the active dialect has no translation for. */
  | 'UNSUPPORTED_OP'
  /** A property that is not in the collection's queryables. */
  | 'UNKNOWN_PROPERTY';

/**
 * Every failure raised while translating a filter. Callers map this to HTTP 400
 * — a malformed filter is a client error. Anything else escaping the translator
 * is a bug and should keep its 500.
 */
export class Cql2Error extends Error {
  readonly code: Cql2ErrorCode;
  readonly detail: string | undefined;

  constructor(code: Cql2ErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'Cql2Error';
    this.code = code;
    this.detail = detail;
  }
}
