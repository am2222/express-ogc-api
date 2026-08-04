/**
 * Errors the library itself raises to signal that a write request was
 * rejected for a reason that is the *client's* fault — an invalid property
 * value, a missing required property, a reference to a property the
 * collection doesn't have, or a value that collides with an existing
 * feature. Handlers map this to an HTTP 4xx response instead of letting it
 * fall through to the generic 500 path.
 *
 * This is deliberately not "schema validation" — the library does not
 * validate a request body against the published schema before writing (see
 * `DuckDBProvider`'s write methods). It exists so that a rejection the
 * *database* already detected (a NOT NULL violation, an enum value that
 * doesn't exist, …) can be translated into something an API consumer can
 * act on, without leaking the database's internal representation (DuckDB's
 * physical storage type for an enum, its exact error wording, etc).
 */
export type FeatureValidationErrorStatus = 400 | 409;

export interface FeatureValidationErrorOptions {
  /** The feature property this rejection is about, when it could be determined. */
  property?: string;
  /**
   * The HTTP status a handler should respond with. Defaults to 400. 409 is
   * for a uniqueness conflict (primary key / unique constraint) — the
   * request is well-formed, but it collides with a feature that already
   * exists.
   */
  status?: FeatureValidationErrorStatus;
  /** The original error (typically the database's), preserved for server-side logs. */
  cause?: unknown;
}

export class FeatureValidationError extends Error {
  readonly property?: string;
  readonly status: FeatureValidationErrorStatus;

  constructor(message: string, options: FeatureValidationErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'FeatureValidationError';
    this.property = options.property;
    this.status = options.status ?? 400;
  }
}

export default FeatureValidationError;
