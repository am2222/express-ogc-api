import { describe, it, expect, vi } from 'vitest';
import { MetadataMemo } from '../src/providers/metadata-memo.js';

describe('MetadataMemo', () => {
    it('shares one lookup between concurrent callers', async () => {
        const memo = new MetadataMemo(1000);
        const load = vi.fn(async () => 'geometry');
        await Promise.all([memo.memo('k', load), memo.memo('k', load)]);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('looks again once the TTL has passed', async () => {
        let now = 0;
        const memo = new MetadataMemo(1000, () => now);
        const load = vi.fn(async () => 'x');
        await memo.memo('k', load);
        now = 1001;
        await memo.memo('k', load);
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('does not remember a failed lookup', async () => {
        const memo = new MetadataMemo(1000);
        const load = vi.fn().mockRejectedValueOnce(new Error('catalog down')).mockResolvedValueOnce('ok');
        await expect(memo.memo('k', load)).rejects.toThrow('catalog down');
        await expect(memo.memo('k', load)).resolves.toBe('ok');
    });
});
