import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), select: vi.fn(), eq: vi.fn() }));
vi.mock('../lib/supabase.js', () => ({ getSupabase: () => mocks }));
import { diamondCustodyRecovery } from './diamond-custody-recovery.js';

const app = new Hono().post('/cron/diamond-custody-recovery', diamondCustodyRecovery);
const run = () => app.request('/cron/diamond-custody-recovery', { method: 'POST' });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.rpc.mockResolvedValueOnce({ data: 2, error: null })
    .mockResolvedValueOnce({ data: [], error: null });
  mocks.from.mockReturnValue(mocks);
  mocks.select.mockReturnValue(mocks);
  mocks.eq.mockResolvedValue({ count: 0, error: null });
});
describe('Diamond custody recovery', () => {
  it('reports completed refunds after independent diagnostics', async () => {
    const r = await run();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, recovered: 2, pending: 0, discrepancies: 0 });
    expect(mocks.rpc.mock.calls).toEqual([['fn_poker_diamond_recover_releases'], ['fn_poker_diamond_custody_discrepancies']]);
    expect(mocks.eq).toHaveBeenCalledWith('state', 'pending');
  });
  it('retains the committed count when diagnostics fail', async () => {
    mocks.rpc.mockReset().mockResolvedValueOnce({ data: 2, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'report unavailable' } });
    const r = await run();
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ ok: false, recovered: 2, error: 'report unavailable' });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });
  it.each([null, -1, 1.5, 17, '2'])('rejects invalid recovery count %s', async (value) => {
    mocks.rpc.mockReset().mockResolvedValue({ data: value, error: null });
    const r = await run();
    expect(r.status).toBe(503);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it('reports unresolved obligations without claiming completion', async () => {
    mocks.eq.mockResolvedValue({ count: 1, error: null });
    const r = await run();
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ ok: false, recovered: 2, pending: 1 });
  });
  it('reports reconciliation differences', async () => {
    mocks.rpc.mockReset().mockResolvedValueOnce({ data: 0, error: null })
      .mockResolvedValueOnce({ data: [{ kind: 'lot_mismatch' }], error: null });
    const r = await run();
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ ok: false, discrepancies: 1 });
  });
  it('does not accept a missing pending count as zero', async () => {
    mocks.eq.mockResolvedValue({ count: null, error: null });
    const r = await run();
    expect(r.status).toBe(503);
  });
  it('reports a failed recovery RPC without running diagnostics', async () => {
    mocks.rpc.mockReset().mockResolvedValue({ data: null, error: { message: 'database unavailable' } });
    const r = await run();
    expect(r.status).toBe(503);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});
