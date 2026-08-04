/**
 * JWT signing/verification for the demo server, plus the Express middleware
 * that turns a token in the URL path into `res.locals.key`.
 *
 * A copyable pattern, not library API — the same caveats as
 * `prefixed-duckdb-provider.ts` apply: read it, understand it, take
 * ownership of it before using it anywhere real.
 *
 * ## Why the token is in the path
 *
 * OGC API - Features clients (QGIS in particular) let you enter a URL for a
 * connection, but not always an `Authorization` header. Putting the token in
 * the path means a single copy-pasted URL is all a client needs, and every
 * link the API generates carries the token forward automatically, because the
 * library builds links from `req.baseUrl` (see `BaseHandler.buildUrl`).
 *
 * The trade-off is real and worth stating plainly: a token in a URL path is
 * far more exposed than one in a header. It lands in server access logs,
 * proxy logs, browser history, and `Referer` headers on any outbound link.
 * That is acceptable for a local demo over localhost. For production, prefer
 * `Authorization: Bearer <token>` and keep secrets out of URLs.
 */

import jwt from 'jsonwebtoken';
import type { RequestHandler } from 'express';

/**
 * The signing secret. Demo-only default so `npx tsx examples/serve-demo.ts`
 * works with no setup; override with `DEMO_JWT_SECRET` for anything else.
 * A hardcoded fallback secret is exactly the thing you must not ship —
 * anyone who reads this file can mint a valid token.
 */
export const SECRET_KEY =
  process.env.DEMO_JWT_SECRET ?? 'demo-only-not-a-real-secret';

export const TOKEN_TTL = '8h';

/**
 * What a token is allowed to do. `ro` permits the safe methods only; `rw` also
 * permits POST/PUT/PATCH/DELETE.
 *
 * The split exists because of how this scheme propagates. A token in the URL
 * ends up inside every link the API returns, which means it gets saved into
 * client-side artifacts — a QGIS `.qgs`/`.qgz` project file, most obviously —
 * and those get emailed around and committed to repos. A read-only token
 * leaking that way costs you a data read. A read-write token leaking that way
 * costs you `DELETE` on every feature in the tenant until it expires. So the
 * token you paste into a GIS client should be `ro`, and writes should need a
 * separately minted `rw` token that never goes near a saved project file.
 */
export type DemoScope = 'ro' | 'rw';

/** HTTP methods a read-only token may use. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Claims the demo cares about. `db` selects which tenant the token unlocks. */
export interface DemoClaims {
  /** Tenant key — becomes `res.locals.key`, so it must be a known tenant. */
  db: string;
  /**
   * Read-only or read-write. Optional, and **absence means `ro`** — see
   * `isReadWrite` below for why it fails closed rather than open.
   */
  scope?: DemoScope;
  /** Who the token was issued to. Not used for authorization here. */
  sub?: string;
}

export type VerifiedClaims = DemoClaims & jwt.JwtPayload;

/** Sign a token that expires in {@link TOKEN_TTL}. */
export function getToken(claims: DemoClaims): string {
  return jwt.sign(claims, SECRET_KEY, { expiresIn: TOKEN_TTL });
}

/**
 * Verify a token. Returns the decoded claims, or `false` if the token is
 * malformed, tampered with, signed with a different key, or expired —
 * `jwt.verify` throws in all of those cases.
 */
export function useToken(token: string): VerifiedClaims | false {
  try {
    const payload = jwt.verify(token, SECRET_KEY);
    // A token whose payload is a bare string (`jwt.sign('hello', ...)`) has no
    // claims to read, so it can't authorize anything here.
    if (typeof payload === 'string') {
      return false;
    }
    return payload as VerifiedClaims;
  } catch {
    return false;
  }
}

/**
 * Whether a set of verified claims permits writes.
 *
 * Fails closed: only the exact string `rw` grants write access. A token with
 * no `scope`, an empty one, a misspelled one (`"write"`, `"RW"`), or a
 * non-string one is read-only. The alternative — treating an unrecognized
 * scope as permissive — would mean a typo in a mint call silently hands out
 * `DELETE`, which is the wrong direction to be wrong in.
 */
export function isReadWrite(claims: VerifiedClaims): boolean {
  return claims.scope === 'rw';
}

/**
 * Middleware for a router mounted at `/:token/ogc`: verifies `req.params.token`
 * and, on success, resolves the tenant from the token's `db` claim onto
 * `res.locals.key` (which `PrefixedDuckDBProvider` reads) and the full claims
 * onto `res.locals.claims`.
 *
 * Two distinct rejections, both 403:
 *
 * 1. **The token isn't usable at all** — missing, malformed, badly signed,
 *    expired, carrying no usable `db` claim, or naming a database this server
 *    doesn't serve. These deliberately share one status and one vague
 *    description: distinguishing "expired" from "bad signature" from "unknown
 *    database" tells someone probing with guessed tokens which part of their
 *    guess was right.
 *
 * 2. **The token is valid but read-only, and this is a write.** This one *is*
 *    reported specifically, and that's not an inconsistency with the above.
 *    The caller has already proven they hold a validly signed token, so naming
 *    the reason leaks nothing they couldn't determine anyway — and a client
 *    that gets an opaque 403 on a write it's allowed to make in principle has
 *    no way to tell "my token expired" from "my token is the read-only one",
 *    which is a genuinely confusing thing to debug.
 *
 * 403 rather than 401 in both cases because there is no `WWW-Authenticate`
 * challenge to issue — the client can't fix this by retrying with credentials,
 * it needs a different token.
 */
export function requireToken(knownTenants: Set<string>): RequestHandler {
  return (req, res, next) => {
    const deny = () => {
      res.status(403).json({
        code: '403',
        description: 'Invalid or expired token',
      });
    };

    const token = req.params.token;
    if (!token) {
      deny();
      return;
    }

    const claims = useToken(token);
    if (!claims) {
      deny();
      return;
    }

    if (typeof claims.db !== 'string' || !knownTenants.has(claims.db)) {
      deny();
      return;
    }

    // Method check, not path check. Guarding by URL would mean every route
    // added later has to be remembered here; guarding by method means a new
    // write route is covered the moment it exists.
    if (!READ_METHODS.has(req.method) && !isReadWrite(claims)) {
      res.status(403).json({
        code: '403',
        description: `Token is read-only; ${req.method} requires a read-write token`,
      });
      return;
    }

    res.locals.key = claims.db;
    res.locals.claims = claims;
    next();
  };
}
