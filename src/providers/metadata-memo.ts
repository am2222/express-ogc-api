/**
 * Time-bounded memo for per-table metadata lookups.
 *
 * Promises are stored rather than values, so concurrent requests for the same
 * table (a client opening a project fires many at once) share one lookup. A
 * rejected lookup is evicted immediately, so a transient catalog error is not
 * remembered for the whole TTL.
 */
export class MetadataMemo {
    private readonly entries = new Map<string, { value: Promise<unknown>; until: number }>();

    constructor(
        private readonly ttlMs: number,
        private readonly now: () => number = Date.now
    ) {}

    memo<T>(key: string, load: () => Promise<T>): Promise<T> {
        const hit = this.entries.get(key);
        if (hit && hit.until > this.now()) {
            return hit.value as Promise<T>;
        }
        const value = load();
        this.entries.set(key, { value, until: this.now() + this.ttlMs });
        value.catch(() => {
            if (this.entries.get(key)?.value === value) {
                this.entries.delete(key);
            }
        });
        return value;
    }
}
