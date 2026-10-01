import { describe, expect, it } from 'vitest';
import {
  NIGHTLY_ACQUIRE_RPC,
  NIGHTLY_RELEASE_RPC,
  NIGHTLY_TICK_RPC,
  runNightlyTournamentOwner,
  tournamentHorsesReleased,
  tournamentsReleased,
  type NightlyRpc,
} from './trivia-nightly-tournament.js';

function harness(script: Record<string, Array<{ data?: unknown; error?: { message: string } | null }>>) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let clock = 0;
  const rpc: NightlyRpc = async (fn, args) => {
    calls.push({ fn, args });
    const next = script[fn]?.shift() ?? { data: { success: true } };
    return { data: next.data ?? null, error: next.error ?? null };
  };
  return {
    calls,
    deps: {
      rpc,
      env: { TRIVIA_TOURNAMENTS_ENABLED: 'true', TRIVIA_TOURNAMENT_HORSES_ENABLED: 'true' },
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; },
      holderId: 'workers:test:1:abc',
    },
  };
}

const OWNER = { data: { owner: true, run_id: 'run-1', fencing_token: 7 } };

describe('release controls', () => {
  it('only exact lowercase true enables, horses need both', () => {
    expect(tournamentsReleased({})).toBe(false);
    expect(tournamentsReleased({ TRIVIA_TOURNAMENTS_ENABLED: 'TRUE' })).toBe(false);
    expect(tournamentsReleased({ TRIVIA_TOURNAMENTS_ENABLED: 'true' })).toBe(true);
    expect(tournamentHorsesReleased({ TRIVIA_TOURNAMENT_HORSES_ENABLED: 'true' })).toBe(false);
    expect(tournamentHorsesReleased({ TRIVIA_TOURNAMENTS_ENABLED: 'true', TRIVIA_TOURNAMENT_HORSES_ENABLED: 'true' })).toBe(true);
  });
});

describe('runNightlyTournamentOwner', () => {
  it('stands by without ticking when another owner holds the lease', async () => {
    const h = harness({ [NIGHTLY_ACQUIRE_RPC]: [{ data: { owner: false, run_id: 'run-2' } }] });
    const out = await runNightlyTournamentOwner(h.deps);
    expect(out.status).toBe(200);
    expect(out.body.standby).toBe(true);
    expect(h.calls.map((c) => c.fn)).toEqual([NIGHTLY_ACQUIRE_RPC]);
  });

  it('ticks with the fencing token while the database asks for fast polls, then releases', async () => {
    const h = harness({
      [NIGHTLY_ACQUIRE_RPC]: [OWNER],
      [NIGHTLY_TICK_RPC]: [
        { data: { healthy: true, next_poll_ms: 2000 } },
        { data: { healthy: true, next_poll_ms: 2000 } },
        { data: { healthy: true, next_poll_ms: 60000 } },
      ],
    });
    const out = await runNightlyTournamentOwner(h.deps);
    expect(out.status).toBe(200);
    expect(out.body.ticks).toBe(3);
    const ticks = h.calls.filter((c) => c.fn === NIGHTLY_TICK_RPC);
    expect(ticks.every((c) => c.args.p_fencing_token === 7 && c.args.p_run_id === 'run-1')).toBe(true);
    expect(ticks[0].args.p_horses_enabled).toBe(true);
    expect(h.calls.at(-1)?.fn).toBe(NIGHTLY_RELEASE_RPC);
  });

  it('never exceeds its budget', async () => {
    const live = Array.from({ length: 100 }, () => ({ data: { healthy: true, next_poll_ms: 2000 } }));
    const h = harness({ [NIGHTLY_ACQUIRE_RPC]: [OWNER], [NIGHTLY_TICK_RPC]: live });
    const out = await runNightlyTournamentOwner({ ...h.deps, budgetMs: 45000 });
    expect(Number(out.body.ticks)).toBeLessThanOrEqual(23);
    expect(h.calls.at(-1)?.fn).toBe(NIGHTLY_RELEASE_RPC);
  });

  it('reports a failing business outcome as 500 (pages), not a green HTTP', async () => {
    const h = harness({
      [NIGHTLY_ACQUIRE_RPC]: [OWNER],
      [NIGHTLY_TICK_RPC]: [{ data: { healthy: false, alerts: [{ code: 'start_late' }], next_poll_ms: 60000 } }],
    });
    const out = await runNightlyTournamentOwner(h.deps);
    expect(out.status).toBe(500);
    expect(out.body.alerts).toEqual([{ code: 'start_late' }]);
  });

  it('stops immediately when fenced out by a newer owner and does not release its lease', async () => {
    const h = harness({
      [NIGHTLY_ACQUIRE_RPC]: [OWNER],
      [NIGHTLY_TICK_RPC]: [{ error: { message: 'stale_fencing_token' } }],
    });
    const out = await runNightlyTournamentOwner(h.deps);
    expect(out.status).toBe(200);
    expect(out.body.fenced).toBe(true);
    expect(h.calls.map((c) => c.fn)).toEqual([NIGHTLY_ACQUIRE_RPC, NIGHTLY_TICK_RPC]);
  });

  it('turns horses off unless both switches are exactly true', async () => {
    const h = harness({ [NIGHTLY_ACQUIRE_RPC]: [OWNER], [NIGHTLY_TICK_RPC]: [{ data: { healthy: true, next_poll_ms: 60000 } }] });
    await runNightlyTournamentOwner({ ...h.deps, env: { TRIVIA_TOURNAMENTS_ENABLED: 'true' } });
    expect(h.calls.find((c) => c.fn === NIGHTLY_TICK_RPC)?.args.p_horses_enabled).toBe(false);
  });
});
