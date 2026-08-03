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

/** Claims the demo cares about. `db` selects which tenant the token unlocks. */
export interface DemoClaims {
  /** Tenant key — becomes `res.locals.key`, so it must be a known tenant. */
  db: string;
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
 * Middleware for a router mounted at `/:token/ogc`: verifies `req.params.token`
 * and, on success, resolves the tenant from the token's `db` claim onto
 * `res.locals.key` (which `PrefixedDuckDBProvider` reads) and the full claims
 * onto `res.locals.claims`.
 *
 * Failure modes, all 403 with an OGC-style exception body:
 *
 * - token missing, malformed, badly signed, or expired
 * - token verifies but carries no usable `db` claim
 * - token verifies but names a database this server doesn't serve
 *
 * They deliberately share one status and one generic-ish description rather
 * than reporting "expired" vs "bad signature" vs "unknown database"
 * separately: distinguishing them tells an attacker probing with guessed
 * tokens which part of their guess was right. 403 (rather than 401) because
 * there is no `WWW-Authenticate` challenge to issue — the client can't fix
 * this by retrying with credentials, it needs a different token.
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

    res.locals.key = claims.db;
    res.locals.claims = claims;
    next();
  };
}
