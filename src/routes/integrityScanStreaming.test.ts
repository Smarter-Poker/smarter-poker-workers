import { describe, it, expect, vi } from 'vitest';
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { resolveScanWindow } from '../lib/scanWindow.js';
import { antiCheatBotTiming } from './anti-cheat-bot-timing.js';
import { antiCheatChipDump } from './anti-cheat-chip-dump.js';
vi.mock('../lib/supabase.js', () => ({ getSupabase: vi.fn() }));
vi.mock('../lib/scanWindow.js', () => ({
  resolveScanWindow: vi.fn(), dedupeSinceFor: () => new Date('2026-09-12T00:00:00Z'),
  ScanWindowError: class extends Error {},
}));

function dbFixture(total: number, failAt = -1, existing: object[] = []) {
  const calls: Array<[string, ...unknown[]]> = []; const flags: object[] = [];
  const from = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'gte', 'lt', 'not', 'order', 'limit']) {
      query[method] = (...args: unknown[]) => { calls.push([table + '.' + method, ...args]); return query; };
    }
    query.range = async (start: number, end: number) => {
      calls.push(['range', start, end]);
      if (start === failAt) return { data: null, error: { message: 'incomplete page' } };
      const data = Array.from({ length: Math.max(0, Math.min(total, end + 1) - start) }, (_, n) => ({
        id: `${start + n}`, created_at: '2026-09-13T00:00:00Z', pot_size: 200,
        actions: [{ id: 'giver', ts: 100 }, { id: 'giver', ts: 200 }],
        players: [{ id: 'giver', chips_invested: 200 }, { id: 'receiver', chips_invested: 200 }],
        winners: [{ id: 'receiver' }],
      }));
      return { data, error: null };
    };
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: existing, error: null }));
    query.insert = async (flag: object) => { flags.push(flag); return { error: null }; };
    return query;
  };
  vi.mocked(getSupabase).mockReturnValue({ from } as unknown as ReturnType<typeof getSupabase>);
  return { calls, flags };
}

describe.each([
  ['bot timing', antiCheatBotTiming, 1], ['chip dump', antiCheatChipDump, 2],
] as const)('%s streaming route', (_name, handler, flagCount) => {
  function context(dryRun = false) {
    vi.mocked(resolveScanWindow).mockResolvedValue({ start: new Date('2026-09-12T00:00:00Z'), end: new Date('2026-09-13T00:00:00Z'), dryRun, overridden: true });
    const json = vi.fn((body, status) => ({ body, status })); return { json } as unknown as Context;
  }
  it('retains scope, all pages, flag evidence and the existing response contract', async () => {
    const db = dbFixture(1004); const c = context(); await handler(c);
    expect(db.flags).toHaveLength(flagCount);
    expect(db.calls).toContainEqual(['hand_history.gte', 'created_at', '2026-09-12T00:00:00.000Z']);
    expect(db.calls).toContainEqual(['hand_history.lt', 'created_at', '2026-09-13T00:00:00.000Z']);
    expect(db.calls).toContainEqual(['hand_history.order', 'id', { ascending: false }]);
    expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, hands_scanned: 1004, hands_truncated: false, flags_written: flagCount, dry_run: false }));
    for (const flag of db.flags) {
      expect(flag).toMatchObject({ status: 'open', severity: _name === 'bot timing' ? 'critical' : 'high' });
      const reason = JSON.parse((flag as { reason: string }).reason);
      if (_name === 'bot timing') expect(reason).toMatchObject({ actions_sampled: 1004, mean_delta_ms: 100, std_delta_ms: 0 });
      else expect(reason).toMatchObject({ hands_together: 1004, net_chips_transferred: 200800, giver_win_rate_excluding_pair: 0 });
    }
  });
  it('does not emit partial flags after a later page fails', async () => {
    const db = dbFixture(1500, 1000); const c = context(); await handler(c);
    expect(db.flags).toEqual([]);
    expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errors: ['hand_history scan: incomplete page'] }), 500);
  });
  it('preserves dry-run: full scan and computed counts without writes', async () => {
    const db = dbFixture(1004); const c = context(true); await handler(c);
    expect(db.flags).toEqual([]);
    expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ hands_scanned: 1004, flags_written: flagCount, dry_run: true }));
  });
  it('preserves open-flag deduplication for each existing counterparty', async () => {
    const existing = [{ id: 'flag1', reason: JSON.stringify({ counterparty_user_id: 'receiver' }) },
      { id: 'flag2', reason: JSON.stringify({ counterparty_user_id: 'giver' }) }];
    const db = dbFixture(1004, -1, existing); const c = context(); await handler(c);
    expect(db.flags).toEqual([]);
    expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ flags_written: 0, flags_skipped_existing: flagCount }));
  });
});
