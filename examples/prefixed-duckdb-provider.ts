/**
 * A copyable pattern, not library API.
 *
 * `DuckDBProvider` (in `src/providers/duck-db-provider.ts`) is tenant-free:
 * it maps collection ids to table names with the identity function unless
 * you override `physicalTableName`/`collectionIdForTable`. This file shows
 * one concrete way to build multi-tenant table-name prefixing on top of it,
 * by subclassing and overriding those two hooks.
 *
 * Copy this file into your own application and adapt it — it is not
 * exported from the package's public entry point, and it is not meant to
 * be. Treat it the same way you'd treat a Stack Overflow answer you're
 * pasting into your own codebase: read it, understand it, and take
 * ownership of it.
 *
 * The two overrides below (`physicalTableName` and `collectionIdForTable`)
 * MUST stay exact inverses of each other. `physicalTableName` prepends
 * `<key>_`; `collectionIdForTable` strips it back off (or returns `null` if
 * the table doesn't carry that tenant's prefix, hiding it from this
 * request). If you change one without mirroring the change in the other,
 * discovery (`GET /collections`) will advertise collection ids that reads
 * can't resolve, or — the security-relevant failure — a crafted collection
 * id could resolve into a different tenant's table.
 */

import { DuckDBProvider } from '../src/index.js';
import type { DuckDBLocals, ProviderRequest } from '../src/index.js';

/**
 * Locals this subclass needs beyond the base `DuckDBLocals`: a `key`
 * identifying which tenant the current request belongs to. Application
 * middleware is responsible for setting `res.locals.key` (alongside
 * `res.locals.db`) before the OGC router runs.
 */
export type PrefixedLocals = DuckDBLocals & { key: string };

type PrefixedRequest = ProviderRequest<Record<string, string>, PrefixedLocals>;

/**
 * Validate a tenant key. This is the validation that used to live inside
 * the library's `DuckDBProvider` itself; moving tenancy out of the library
 * doesn't relax the requirement, because it's a security boundary, not a
 * style preference:
 *
 * - The key must be present and non-empty. An empty string must not
 *   silently mean "no tenant" — that would turn discovery into a
 *   full-catalog scan and every table reference unprefixed, defeating
 *   isolation entirely.
 * - The key must consist only of `[A-Za-z0-9]`. In particular it must not
 *   contain `_`, because `_` is the separator between the key and the
 *   collection id in `<key>_<collectionId>`. Allowing `_` in the key would
 *   let one tenant's key be crafted to collide with another tenant's
 *   prefix (e.g. key `acme` can only ever address `acme_*` tables, but if
 *   underscores were allowed in keys, a key of `acme_eu` would let that
 *   tenant address `acme_eu_*` — indistinguishable from a legitimate
 *   sub-tenant of `acme`, and vice versa: `acme`'s tables would be a
 *   prefix-match subset of `acme_eu`'s, so naive prefix checks could leak
 *   across tenants).
 */
function assertValidKey(key: unknown): asserts key is string {
    if (typeof key !== 'string' || key.length === 0 || !/^[A-Za-z0-9]+$/.test(key)) {
        throw new Error(
            `Invalid res.locals.key: ${JSON.stringify(key)} — tenant key must be a non-empty string containing only letters and digits (no underscores, which are reserved as the tenant/collection separator)`
        );
    }
}

/**
 * A `DuckDBProvider` that namespaces every collection under a per-request
 * tenant key, by prefixing physical table names with `<key>_`.
 *
 * Unlike the library's old built-in behaviour, an **absent** key is not
 * treated as "flat, single-tenant mode" here. This class exists *only* to
 * do prefixing, so a request that reaches it without a key is almost
 * certainly a middleware wiring bug (forgot to set `res.locals.key`) rather
 * than a deliberate choice to skip tenancy — and failing open in that case
 * would mean the request falls through to unprefixed table names, which in
 * a genuinely multi-tenant deployment could be another tenant's data (or,
 * if no unprefixed tables exist, a confusing "collection not found" instead
 * of a clear configuration error). So: the key is required, and a missing
 * or invalid key throws. If you want a single flat deployment with no
 * tenancy at all, use `DuckDBProvider` directly instead of this subclass.
 */
export class PrefixedDuckDBProvider extends DuckDBProvider {
    /**
     * `<key>_<collectionId>` — the physical table backing a collection id
     * for this request's tenant. Must stay the exact inverse of
     * `collectionIdForTable` below.
     */
    protected override physicalTableName(req: PrefixedRequest, collectionId: string): string {
        const key = this.tenantKey(req);
        return `${key}_${collectionId}`;
    }

    /**
     * The inverse of `physicalTableName`: strips this request's `<key>_`
     * prefix off a discovered table name to get the collection id, or
     * returns `null` if the table doesn't carry that prefix at all (which
     * hides it from this tenant's `GET /collections` — it belongs to some
     * other tenant, or isn't tenant-scoped).
     */
    protected override collectionIdForTable(req: PrefixedRequest, tableName: string): string | null {
        const key = this.tenantKey(req);
        const prefix = `${key}_`;
        return tableName.startsWith(prefix) ? tableName.slice(prefix.length) : null;
    }

    /** Read and validate the tenant key set by middleware at `res.locals.key`. */
    private tenantKey(req: PrefixedRequest): string {
        const key: unknown = req.res?.locals?.key;
        assertValidKey(key);
        return key;
    }
}
