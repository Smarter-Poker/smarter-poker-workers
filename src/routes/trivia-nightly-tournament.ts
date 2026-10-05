/**
 * GET/POST /cron/trivia-nightly-tournament
 *
 * Phase 6 owner of the nightly 8:00 PM America/Chicago Trivia tournament: the
 * ONE canonical OpenClaw job identity (`openclaw:trivia-nightly-tournament`).
 *
 * Each invocation: release control -> acquire the database lease (a fencing
 * token for this invocation only) -> call the authoritative tick until nothing
 * is due inside this invocation's budget -> release the lease. Every business
 * rule (schedule, horse population, bracket, advancement, settlement) lives in
 * the trivia_tournament_* database functions; this route only invokes them.
 *
 * - Another live owner holds the lease -> 200 { owner:false } (standby).
 * - The lease was taken over mid-run (stale fencing token) -> stop at once.
 * - Domain health fails (missing instance, short horse field, late start,
 *   stuck round, late settlement) or a tick step errors -> 500, so OpenClaw's
 *   CRITICAL_JOBS paging fires. HTTP success means the business outcome is OK.
 * - TRIVIA_TOURNAMENTS_ENABLED is not exactly 'true' -> 503, nothing is read.
 *   Horses join only when TRIVIA_TOURNAMENT_HORSES_ENABLED is also 'true'.
 *
 * Auth: /cron/* middleware chain (IP allowlist + CRON secret).
 */
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { getSupabase } from '../lib/supabase.js';

export const NIGHTLY_ACQUIRE_RPC = 'trivia_tournament_scheduler_acquire';
export const NIGHTLY_TICK_RPC = 'trivia_tournament_scheduler_tick';
export const NIGHTLY_RELEASE_RPC = 'trivia_tournament_scheduler_release';
export const NIGHTLY_LEASE_SECONDS = 60;
export const NIGHTLY_BUDGET_MS = 45_000;
export const NIGHTLY_MAX_STEPS = 400;
export const NIGHTLY_MIN_POLL_MS = 250;
export const NIGHTLY_MAX_POLL_MS = 300_000;

type Env = Record<string, string | undefined>;
type RpcResult = { data: unknown; error: { message: string } | null };
export type NightlyRpc = (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;

export function tournamentsReleased(env: Env = process.env): boolean {
  return env.TRIVIA_TOURNAMENTS_ENABLED === 'true';
}

export function tournamentHorsesReleased(env: Env = process.env): boolean {
  return tournamentsReleased(env) && env.TRIVIA_TOURNAMENT_HORSES_ENABLED === 'true';
}

export function nightlyHolderId(): string {
  const host = hostname().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60) || 'workers';
  return `workers:${host}:${process.pid}:${randomUUID()}`;
}

interface TickResult {
  healthy?: boolean;
  alerts?: unknown[];
  errors?: unknown[];
  actions?: Record<string, unknown>;
  next_poll_ms?: number;
}

export interface OwnerDeps {
  rpc: NightlyRpc;
  env: Env;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  holderId: string;
  budgetMs?: number;
}

export interface OwnerOutcome {
  status: 200 | 500;
  body: Record<string, unknown>;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseFencingToken(value: unknown): number | null {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function runNightlyTournamentOwner(deps: OwnerDeps): Promise<OwnerOutcome> {
  const started = deps.now();
  const budget = deps.budgetMs ?? NIGHTLY_BUDGET_MS;
  const acquired = await deps.rpc(NIGHTLY_ACQUIRE_RPC, {
    p_holder_id: deps.holderId,
    p_lease_seconds: NIGHTLY_LEASE_SECONDS,
  });
  if (acquired.error) {
    return { status: 500, body: { ok: false, error: 'lease_unavailable', detail: acquired.error.message } };
  }
  const lease = acquired.data as { owner?: unknown; run_id?: unknown; fencing_token?: unknown } | null;
  if (!lease || (lease.owner !== true && lease.owner !== false) || !isUuid(lease.run_id)) {
    return { status: 500, body: { ok: false, error: 'invalid_lease_response' } };
  }
  if (lease.owner === false) {
    return { status: 200, body: { ok: true, owner: false, standby: true, runId: lease.run_id } };
  }
  const fencingToken = parseFencingToken(lease.fencing_token);
  if (fencingToken === null) {
    return { status: 500, body: { ok: false, error: 'invalid_lease_response' } };
  }

  let ticks = 0;
  let last: TickResult | null = null;
  let tickError: string | null = null;
  let releaseError: string | null = null;
  let fenced = false;
  try {
    for (;;) {
      const tick = await deps.rpc(NIGHTLY_TICK_RPC, {
        p_run_id: lease.run_id,
        p_fencing_token: fencingToken,
        p_horses_enabled: tournamentHorsesReleased(deps.env),
        p_max_steps: NIGHTLY_MAX_STEPS,
      });
      ticks += 1;
      if (tick.error) {
        fenced = /stale_fencing_token/.test(tick.error.message);
        tickError = fenced ? null : tick.error.message;
        break;
      }
      last = (tick.data ?? {}) as TickResult;
      const next = Number(last.next_poll_ms);
      if (!Number.isFinite(next) || next < NIGHTLY_MIN_POLL_MS || next > NIGHTLY_MAX_POLL_MS) {
        tickError = 'invalid_next_poll_ms';
        break;
      }
      if (next >= 60_000 || deps.now() - started + next > budget) break;
      await deps.sleep(next);
    }
  } finally {
    if (!fenced) {
      try {
        const released = await deps.rpc(NIGHTLY_RELEASE_RPC, {
          p_run_id: lease.run_id,
          p_fencing_token: fencingToken,
        });
        if (released.error) {
          releaseError = released.error.message;
        } else if ((released.data as { released?: unknown } | null)?.released !== true) {
          releaseError = 'release_not_confirmed';
        }
      } catch (err) {
        releaseError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  if (fenced) {
    // Another owner took over; this invocation stops without acting further.
    return { status: 200, body: { ok: true, owner: false, fenced: true, ticks } };
  }
  const errors = Array.isArray(last?.errors) ? [...last.errors] : [];
  if (tickError) errors.push({ step: 'tick', error: tickError });
  if (releaseError) errors.push({ step: 'release', error: releaseError });
  const healthy = tickError === null && releaseError === null && last?.healthy === true;
  return {
    status: healthy ? 200 : 500,
    body: {
      ok: healthy,
      owner: true,
      fencingToken,
      ticks,
      healthy: last?.healthy ?? false,
      alerts: last?.alerts ?? [],
      errors,
      actions: last?.actions ?? {},
      ms: deps.now() - started,
    },
  };
}

export async function triviaNightlyTournament(c: Context) {
  c.header('Cache-Control', 'no-store');
  if (!tournamentsReleased()) {
    c.header('Retry-After', '300');
    return c.json({ ok: false, error: 'tournaments_temporarily_unavailable' }, 503);
  }
  try {
    const supabase = getSupabase();
    const outcome = await runNightlyTournamentOwner({
      rpc: (fn, args) => supabase.rpc(fn, args),
      env: process.env,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      holderId: nightlyHolderId(),
    });
    console.log(JSON.stringify({ event: 'trivia_nightly_tournament', status: outcome.status, ...outcome.body }));
    return c.json(outcome.body, outcome.status);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[trivia-nightly-tournament] unexpected:', message);
    return c.json({ ok: false, error: 'internal_error', detail: message }, 500);
  }
}
