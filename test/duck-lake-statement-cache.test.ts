import { describe, it, beforeEach, expect } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { DuckLakeProvider } from '../src/index.js';
import type { DuckLakeLocals, DuckLakeTenant, ProviderRequest } from '../src/index.js';

/**
 * Against a remote (Postgres) catalog every statement is a network round trip
 * — measured at ~0.5 s apiece from a dev machine — so these tests count
 * statements, not time: each one avoided is a round trip saved.
 */

type LakeRequest = ProviderRequest<Record<string, string>, DuckLakeLocals>;
const TENANT: DuckLakeTenant = { company: 'GA0gA0DcMF', user: 't5OtsEjChL', project: '7CHCwAJQiO' };
const TABLE = '"GA0gA0DcMF_t5OtsEjChL_7CHCwAJQiO_roads"';

let statements: string[];
let db: DuckDBConnection;

/** The connection, wrapped so every statement it runs is recorded. */
function counted(conn: DuckDBConnection): DuckDBConnection {
    return new Proxy(conn, {
        get(target, prop) {
            const member = Reflect.get(target, prop);
            if (typeof member !== 'function') return member;
            return (...args: unknown[]) => {
                if (typeof args[0] === 'string') statements.push(args[0].replace(/\s+/g, ' '));
                return (member as (...a: unknown[]) => unknown).apply(target, args);
            };
        },
    });
}

function req(): LakeRequest {
    return { params: {}, query: {}, baseUrl: '', res: { locals: { db, tenant: TENANT } } } as unknown as LakeRequest;
}

const count = (pattern: RegExp) => statements.filter((s) => pattern.test(s)).length;
const ID_LOOKUP = /column_name IN \('id', 'fid'\)/;
const DEFAULT_LOOKUP = /SELECT column_default/;
const COUNT = /SELECT COUNT\(\*\)/;

const feature = (id: string) => ({
    type: 'Feature' as const,
    geometry: { type: 'Point' as const, coordinates: [1, 2] },
    properties: { id, name: id },
});

beforeEach(async () => {
    const instance = await DuckDBInstance.create(':memory:');
    const raw = await instance.connect();
    await raw.run('LOAD spatial;');
    await raw.run(`CREATE TABLE ${TABLE} (id VARCHAR, name VARCHAR, geometry GEOMETRY)`);
    await raw.run(`INSERT INTO ${TABLE} VALUES ('a', 'a', ST_Point(1, 2)), ('b', 'b', ST_Point(1, 2)), ('c', 'c', ST_Point(50, 50))`);
    db = counted(raw);
    statements = [];
});

describe('metadataCacheTtlMs also covers the id-column lookups writes make', () => {
    it('looks the id column and its default up once across writes', async () => {
        const provider = new DuckLakeProvider({ name: 'lake', metadataCacheTtlMs: 60_000 });
        await provider.createFeature(req(), 'roads', feature('n1'));
        await provider.createFeature(req(), 'roads', feature('n2'));
        await provider.replaceFeature(req(), 'roads', 'n1', feature('n1'));
        expect(count(ID_LOOKUP)).toBe(1);
        expect(count(DEFAULT_LOOKUP)).toBe(1);
    });

    it('still looks them up per write without the option', async () => {
        const provider = new DuckLakeProvider({ name: 'lake' });
        await provider.createFeature(req(), 'roads', feature('n1'));
        await provider.createFeature(req(), 'roads', feature('n2'));
        expect(count(ID_LOOKUP)).toBeGreaterThanOrEqual(2);
        expect(count(DEFAULT_LOOKUP)).toBe(2);
    });
});

describe('countCacheTtlMs', () => {
    const page = (provider: DuckLakeProvider, offset: number, bbox = [0, 0, 10, 10]) =>
        provider.getFeatures(req(), 'roads', { limit: 1, offset, bbox } as never);

    it('counts once while paging through the same query', async () => {
        const provider = new DuckLakeProvider({ name: 'lake', countCacheTtlMs: 60_000 });
        const first = await page(provider, 0);
        const second = await page(provider, 1);
        expect(count(COUNT)).toBe(1);
        expect(first.numberMatched).toBe(2);
        expect(second.numberMatched).toBe(2);
    });

    it('counts a different filter separately', async () => {
        const provider = new DuckLakeProvider({ name: 'lake', countCacheTtlMs: 60_000 });
        const near = await page(provider, 0);
        const all = await page(provider, 0, [0, 0, 100, 100]);
        expect(count(COUNT)).toBe(2);
        expect(near.numberMatched).toBe(2);
        expect(all.numberMatched).toBe(3);
    });

    it('recounts after a write through the provider, so its own writes are never served a stale total', async () => {
        const provider = new DuckLakeProvider({ name: 'lake', countCacheTtlMs: 60_000 });
        expect((await page(provider, 0)).numberMatched).toBe(2);
        await provider.createFeature(req(), 'roads', feature('n1'));
        expect((await page(provider, 0)).numberMatched).toBe(3);
        await provider.deleteFeature(req(), 'roads', 'a');
        expect((await page(provider, 0)).numberMatched).toBe(2);
        await provider.replaceFeature(req(), 'roads', 'n1', {
            ...feature('n1'),
            geometry: { type: 'Point', coordinates: [50, 50] },
        });
        expect((await page(provider, 0)).numberMatched).toBe(1);
        expect(count(COUNT)).toBe(4);
    });

    it('counts every page without the option', async () => {
        const provider = new DuckLakeProvider({ name: 'lake' });
        await page(provider, 0);
        await page(provider, 1);
        expect(count(COUNT)).toBe(2);
    });
});
