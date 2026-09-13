import { describe, it, expect, vi } from 'vitest';
import { scanPages } from './scanPages.js';

const fixture = (total: number, failAt = -1) => {
  const range = vi.fn(async (from: number, to: number) => from === failAt
    ? { data: null, error: { message: 'read failed' } }
    : { data: Array.from({ length: Math.max(0, Math.min(total, to + 1) - from) }, (_, i) => ({ id: from + i })), error: null });
  return { range, build: () => ({ range }) as never };
};

describe('scanPages', () => {
  it.each([[0, 5000, 0, false], [2500, 5000, 2500, false], [3000, 3000, 3000, false], [3001, 3000, 3000, true]])(
    'streams %i matches with cap %i, preserving count and truncation', async (total, cap, count, truncated) => {
      const seen: number[] = [];
      const pageSizes: number[] = [];
      const result = await scanPages<{ id: number }>(fixture(total).build, cap, (rows) => {
        pageSizes.push(rows.length); seen.push(...rows.map((r) => r.id));
      });
      expect(result.count).toBe(count); expect(result.truncated).toBe(truncated);
      expect(seen).toEqual(Array.from({ length: count }, (_, i) => i));
      expect(Math.max(...pageSizes)).toBeLessThanOrEqual(1000);
      expect(result).not.toHaveProperty('rows');
    },
  );
  it('folds one page before asking for the next and never folds the ceiling probe', async () => {
    const s = fixture(2100);
    let folded = 0;
    const build = () => {
      expect(s.range.mock.calls.length).toBe(Math.ceil(folded / 1000));
      return s.build();
    };
    const result = await scanPages(build, 2000, (rows) => { folded += rows.length; });
    expect(folded).toBe(2000); expect(result.truncated).toBe(true);
  });
  it.each([0, 1000, 2000])('fails rather than claiming complete when read %i fails', async (failAt) => {
    await expect(scanPages(fixture(2100, failAt).build, 2000, () => {})).rejects.toThrow('read failed');
  });
  it.each([0, -1, 1001, 1.5])('rejects a page size that would silently under-read: %i', async (pageSize) => {
    await expect(scanPages(fixture(5).build, 100, () => {}, pageSize)).rejects.toThrow('pageSize');
  });
});
