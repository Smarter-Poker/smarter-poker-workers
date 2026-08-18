import { describe, it, expect } from 'vitest';
import { evaluateSolverHealth, MACHINE_SILENT_HOURS, V2_STALL_HOURS } from './solver-watchdog.js';

/**
 * The scenario these thresholds exist for is the real one, reconstructed from
 * production on 2026-08-18:
 *   - v2 last solved 2026-08-15 09:57 (~64h earlier)
 *   - 6,518,462 spots still without strategy_matrix_v2
 *   - zero v2 solves in 24h
 *   - M1 alive and reporting; M2 silent since 2026-08-16 00:38 (~49h)
 * Nothing surfaced any of it for three days.
 */
const NOW = new Date('2026-08-18T01:56:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe('solver watchdog thresholds', () => {
  it('flags the real 2026-08-15 stall that went unnoticed for three days', () => {
    const h = evaluateSolverHealth({
      machines: [
        { machine_id: 'M1', updated_at: hoursAgo(0.01) },
        { machine_id: 'M2', updated_at: hoursAgo(49.3) },
      ],
      v2Done: 1_891_817,
      v2Remaining: 6_518_462,
      v2Last24h: 0,
      lastV2At: hoursAgo(64),
      now: NOW,
    });

    expect(h.status).toBe('warn');
    expect(h.problems.join(' ')).toContain('M2 silent');
    expect(h.problems.join(' ')).toContain('v2 backfill stalled');
    // M1 was healthy the whole time - the check must not blame it.
    expect(h.machines.find((m) => m.machine_id === 'M1')!.down).toBe(false);
    expect(h.machines.find((m) => m.machine_id === 'M2')!.down).toBe(true);
  });

  it('is quiet when the fleet is healthy and v2 is moving', () => {
    const h = evaluateSolverHealth({
      machines: [
        { machine_id: 'M1', updated_at: hoursAgo(0.05) },
        { machine_id: 'M2', updated_at: hoursAgo(0.2) },
      ],
      v2Done: 3_000_000,
      v2Remaining: 5_000_000,
      v2Last24h: 42_000,
      lastV2At: hoursAgo(0.3),
      now: NOW,
    });
    expect(h.status).toBe('ok');
    expect(h.problems).toEqual([]);
  });

  it('does NOT cry stall once the backlog is finished', () => {
    // v2 complete: no recent solves is correct, not a fault. A watchdog that
    // fires forever after success is one people learn to ignore.
    const h = evaluateSolverHealth({
      machines: [{ machine_id: 'M1', updated_at: hoursAgo(0.1) }],
      v2Done: 8_400_000,
      v2Remaining: 0,
      v2Last24h: 0,
      lastV2At: hoursAgo(500),
      now: NOW,
    });
    expect(h.status).toBe('ok');
  });

  it('flags a fleet that has never reported at all', () => {
    const h = evaluateSolverHealth({
      machines: [],
      v2Done: 0,
      v2Remaining: 100,
      v2Last24h: 0,
      lastV2At: null,
      now: NOW,
    });
    expect(h.status).toBe('warn');
    expect(h.problems.join(' ')).toContain('no solver machines');
  });

  it('holds the boundary: just inside the window is not a fault', () => {
    const h = evaluateSolverHealth({
      machines: [{ machine_id: 'M1', updated_at: hoursAgo(MACHINE_SILENT_HOURS - 0.1) }],
      v2Done: 10,
      v2Remaining: 10,
      v2Last24h: 5,
      lastV2At: hoursAgo(V2_STALL_HOURS - 0.1),
      now: NOW,
    });
    expect(h.status).toBe('ok');
  });
});
