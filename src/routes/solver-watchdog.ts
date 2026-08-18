/**
 * GET/POST /cron/solver-watchdog
 *
 * Reports whether the GTO solver fleet is actually producing, into the
 * existing cron_health_log surface (no new infra).
 *
 * WHY THIS EXISTS
 * The v2 re-solve pass died silently. Found 2026-08-18:
 *   solved_spots_gold      8,410,279 rows
 *   strategy_matrix_v2 set 1,891,817 (22.5%)
 *   v2 remaining           6,518,462 (77.5%)
 *   v2 solved in last 24h  ZERO
 *   last v2 solve          2026-08-15 09:57 - nearly three days earlier
 *
 * Nothing surfaced it. The open task said "M2 locked out - capacity, not data
 * loss", but M2 went quiet at 2026-08-16 00:38, roughly fifteen hours AFTER
 * v2 had already stopped, so M2 was never the cause. Meanwhile M1 stayed alive
 * and kept creating NEW v1 spots (49,532 in 24h), which means the v2 backlog
 * was growing while the thing that clears it was dead.
 *
 * Not user-facing: browse-solutions.js prefers strategy_matrix_v2 and falls
 * back to strategy_matrix, so players always get a matrix - 77.5% of spots
 * just serve the older pre-PioSOLVER strategy. That is a quality gap, not an
 * outage, which is exactly the kind of thing that stays invisible without a
 * check like this one.
 *
 * The solver itself runs on LAN machines this codebase cannot reach. This
 * route does not fix the solver; it makes a stall visible within the hour
 * instead of within three days.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

/** A machine silent longer than this is considered down. */
export const MACHINE_SILENT_HOURS = 3;
/** Zero v2 progress for longer than this, with backlog outstanding, is a stall. */
export const V2_STALL_HOURS = 6;

export interface SolverHealth {
  status: 'ok' | 'warn';
  problems: string[];
  machines: Array<{ machine_id: string; hours_silent: number; down: boolean }>;
  v2_remaining: number;
  v2_done: number;
  v2_last_24h: number;
  hours_since_v2: number | null;
}

/**
 * Pure evaluator - kept exported and side-effect free so the thresholds can be
 * tested without a database.
 */
export function evaluateSolverHealth(input: {
  machines: Array<{ machine_id: string; updated_at: string }>;
  v2Done: number;
  v2Remaining: number;
  v2Last24h: number;
  lastV2At: string | null;
  now: Date;
}): SolverHealth {
  const problems: string[] = [];

  const machines = input.machines.map((m) => {
    const hours = (input.now.getTime() - new Date(m.updated_at).getTime()) / 3_600_000;
    const down = hours > MACHINE_SILENT_HOURS;
    if (down) {
      problems.push(`${m.machine_id} silent for ${hours.toFixed(1)}h`);
    }
    return { machine_id: m.machine_id, hours_silent: Number(hours.toFixed(1)), down };
  });

  if (input.machines.length === 0) {
    problems.push('no solver machines have ever reported');
  }

  const hoursSinceV2 =
    input.lastV2At === null
      ? null
      : (input.now.getTime() - new Date(input.lastV2At).getTime()) / 3_600_000;

  // Backlog outstanding but nothing cleared it recently = the stall that went
  // unnoticed for three days.
  if (input.v2Remaining > 0 && hoursSinceV2 !== null && hoursSinceV2 > V2_STALL_HOURS) {
    problems.push(
      `v2 backfill stalled: ${input.v2Remaining.toLocaleString()} spots remaining, ` +
        `no v2 solve for ${hoursSinceV2.toFixed(1)}h`,
    );
  }

  return {
    status: problems.length > 0 ? 'warn' : 'ok',
    problems,
    machines,
    v2_remaining: input.v2Remaining,
    v2_done: input.v2Done,
    v2_last_24h: input.v2Last24h,
    hours_since_v2: hoursSinceV2 === null ? null : Number(hoursSinceV2.toFixed(1)),
  };
}

export async function solverWatchdog(c: Context) {
  const supabase = getSupabase();
  const started = Date.now();

  try {
    const { data: statusRows, error: statusErr } = await supabase
      .from('solver_status')
      .select('machine_id, updated_at');
    if (statusErr) {
      console.warn('[solver-watchdog] solver_status read failed:', statusErr.message);
      return c.json({ error: statusErr.message }, 500);
    }

    const { data: agg, error: aggErr } = await supabase.rpc('fn_solver_v2_progress');
    if (aggErr) {
      console.warn('[solver-watchdog] progress rpc failed:', aggErr.message);
      return c.json({ error: aggErr.message }, 500);
    }
    const a = (agg ?? {}) as Record<string, unknown>;

    const health = evaluateSolverHealth({
      machines: (statusRows ?? []) as Array<{ machine_id: string; updated_at: string }>,
      v2Done: Number(a.v2_done ?? 0),
      v2Remaining: Number(a.v2_remaining ?? 0),
      v2Last24h: Number(a.v2_last_24h ?? 0),
      lastV2At: (a.v2_latest as string | null) ?? null,
      now: new Date(),
    });

    const elapsed = Date.now() - started;

    // Record into the EXISTING cron health surface, keyed on the unique
    // cron_name so this row is a current-state indicator, not an append log.
    const { error: upsertErr } = await supabase.from('cron_health_log').upsert(
      {
        cron_name: 'solver-watchdog',
        last_run_at: new Date().toISOString(),
        last_status: health.status,
        last_duration_ms: elapsed,
        error_message: health.problems.length > 0 ? health.problems.join('; ') : null,
        metadata: health as unknown as Record<string, unknown>,
      },
      { onConflict: 'cron_name' },
    );
    if (upsertErr) {
      console.warn('[solver-watchdog] cron_health_log upsert failed:', upsertErr.message);
    }

    if (health.status === 'warn') {
      console.warn(`[solver-watchdog] WARN - ${health.problems.join('; ')}`);
    } else {
      console.log(
        `[solver-watchdog] ok - v2 ${health.v2_done}/${health.v2_done + health.v2_remaining}, ` +
          `${health.v2_last_24h} solved in 24h`,
      );
    }

    return c.json({ ...health, elapsed_ms: elapsed, run_at: new Date().toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[solver-watchdog] threw:', msg);
    return c.json({ error: msg }, 500);
  }
}
