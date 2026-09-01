import { describe, it, expect, vi } from 'vitest';
import { pagedSelect, PAGE_SIZE } from './pagedSelect.js';

/**
 * Cover for the row cap that made three integrity sweeps blind.
 *
 * PostgREST clamps every response to db-max-rows (1000 here) and returns a
 * 200. `.limit(50000)` therefore came back with 1000 rows and no error, so
 * collusion-scan reported scanned_hands: 1000 against a 24h window holding
 * ~280,000 hands and every "0 findings" it produced was measuring the cap.
 */

/** A stub that behaves like PostgREST: never returns more than `cap` per page. */
function stub(total: number, cap = PAGE_SIZE) {
  const range = vi.fn().mockImplementation((from: number, to: number) => {
    const want = Math.min(to - from + 1, cap);
    const rows = [];
    for (let i = from; i < Math.min(from + want, total); i++) rows.push({ i });
    return Promise.resolve({ data: rows, error: null });
  });
  return { build: () => ({ range }) as never, range };
}

describe('pagedSelect', () => {
  it('reads past the 1000-row cap that a single .limit() could not', async () => {
    const { rows, truncated } = await pagedSelect<{ i: number }>(stub(2500).build, 50_000);
    expect(rows).toHaveLength(2500);
    expect(truncated).toBe(false);
  });

  it('stops at the ceiling and says so, so a partial scan cannot look clean', async () => {
    const { rows, truncated } = await pagedSelect<{ i: number }>(stub(9999).build, 3000);
    expect(rows).toHaveLength(3000);
    expect(truncated).toBe(true);
  });

  it('reports truncated=false when the window ends exactly on the ceiling', async () => {
    const { rows, truncated } = await pagedSelect<{ i: number }>(stub(3000).build, 3000);
    expect(rows).toHaveLength(3000);
    expect(truncated).toBe(false);
  });

  it('handles an empty window without a second round trip', async () => {
    const s = stub(0);
    const { rows, truncated, pages } = await pagedSelect<{ i: number }>(s.build, 50_000);
    expect(rows).toHaveLength(0);
    expect(truncated).toBe(false);
    expect(pages).toBe(1);
  });

  it('surfaces a read error instead of returning a short result silently', async () => {
    const build = () =>
      ({ range: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) as never;
    await expect(pagedSelect(build, 5000)).rejects.toThrow('boom');
  });
});
