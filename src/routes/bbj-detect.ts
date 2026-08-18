/**
 * GET/POST /cron/bbj-detect
 *
 * Phase X4 (Master Gap Ledger 2026-04-28) — closes P0-A5 / WRK-003.
 *
 * Cadence: every 5 minutes (Open Claw scheduler).
 *
 * Scans `hand_history` rows settled in the last 6 minutes (1 min overlap with
 * the cadence to absorb scheduler jitter), and for each hand asks the
 * SQL RPC `fn_bbj_check_eligible(p_hand_id)` whether it qualifies for
 * a Bad Beat Jackpot trigger (quad-aces-or-better cracked at showdown
 * by default, configurable per-club later).
 *
 * For each eligible hand it pulls the table's currently-seated player IDs
 * (excluding winner + loser) and invokes `fn_bbj_payout`, which:
 *   - drains the pool atomically
 *   - inserts bbj_payouts header
 *   - writes bbj_payout_recipients per table-share player
 *   - credits all 3 wallet groups (winner 50% / loser 25% / table 25%)
 *
 * Idempotency: every (hand_id) is checked only once per scan window.
 * If a payout for that hand_id already exists in bbj_payouts, the
 * detector skips. Re-running the cron is therefore safe.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const SCAN_WINDOW_MIN = 6;       // scan last 6 minutes; 5min cron + 1min jitter

// ── Overlap guard ──────────────────────────────────────────────────────────
// A full scan takes ~7 minutes against a 5-minute cadence, so before this
// guard every firing overlapped the previous one: two complete scans (and
// two promo sweeps) were running at all times. We skip a firing while one
// is in flight — but a skip stretches the effective cadence past the fixed
// 6-minute scan window, which would leave hands settled in the gap never
// scanned. So the window is dynamic: each run scans from the previous run's
// START (minus 1 min jitter overlap), bounded to 60 min so a long stall
// can't trigger an unbounded scan. Idempotency (payout-exists skip) makes
// the widened, overlapping windows safe. A stale-in-flight escape (30 min)
// keeps a hung run from blocking the detector until restart.
const SCAN_OVERLAP_MS = 60_000;
const MAX_CATCHUP_MS = 60 * 60_000;
const STALE_INFLIGHT_MS = 30 * 60_000;
let inFlightSinceMs: number | null = null;
let lastScanStartMs: number | null = null;

interface ScanResult {
  hands_scanned: number;
  hands_eligible: number;
  payouts_written: number;
  payouts_skipped_existing: number;
  promo_swept: number;
  errors: string[];
}

export async function bbjDetect(c: Context) {
  const supabase = getSupabase();
  const startedAt = new Date().toISOString();

  if (inFlightSinceMs !== null && Date.now() - inFlightSinceMs < STALE_INFLIGHT_MS) {
    return c.json({ ok: true, skipped: 'overlap', started_at: startedAt });
  }
  inFlightSinceMs = Date.now();

  const sinceMs = lastScanStartMs !== null
    ? Math.max(Date.now() - MAX_CATCHUP_MS, lastScanStartMs - SCAN_OVERLAP_MS)
    : Date.now() - SCAN_WINDOW_MIN * 60_000;
  lastScanStartMs = Date.now();
  const since = new Date(sinceMs).toISOString();

  try {

  const result: ScanResult = {
    hands_scanned: 0,
    hands_eligible: 0,
    payouts_written: 0,
    payouts_skipped_existing: 0,
    promo_swept: 0,
    errors: [],
  };

  // ── Steps 1-5 RETIRED (BBJ audit 2026-08-18, WH audit §40) ──────────────
  //
  // This cron used to scan every settled hand and drive a PARALLEL payout
  // path (fn_bbj_check_eligible + fn_bbj_payout). The audit found that path
  // was a second, WRONG implementation: the eligibility fn matched a field
  // the engine never writes (so it was inert), and had it ever matched it
  // would have paid the QUAD-ACES HOLDER without checking they lost, with
  // no qualifications, no idempotency, wallet credits instead of table
  // stacks, and a backwards 50% split. The engine's settlement path
  // (detectBBJHit + bbj_atomic_payout_v2) is the sole detector/payer -
  // 39/39 live payouts clean - and both DB functions are now retired
  // server-side (they refuse, probed).
  //
  // Removing the scan also cuts this cron from ~413s (one RPC per settled
  // hand, ~2,000 hands per window) to ~1s: the run no longer outlives its
  // 5-minute cadence, so the overlap guard's skip-every-other-firing
  // steady state disappears and the promo sweep truly runs every 5 minutes.

  // 6. Sweep accrued BBJ promo into the union promo wallets.
  //
  // Contributions land 50/25/25 into main/backup/promo on the pool row, but
  // promo_balance is only MONEY IN FLIGHT until fn_sweep_bbj_promo_all()
  // moves it to the union's promo wallet (audit sections 23/29: the one-time
  // manual sweep moved 47,607.05; pools had re-accrued 3,339.90 within two
  // days because nothing recurred). The sweep is idempotent, double-entry
  // ledgered, and cheap (one canonical pool per scope since the 2026-08-17
  // consolidation), so it rides the same 5-minute cadence as detection.
  try {
    const { data: sweep, error: sweepErr } = await supabase.rpc('fn_sweep_bbj_promo_all');
    if (sweepErr) {
      result.errors.push(`fn_sweep_bbj_promo_all: ${sweepErr.message}`);
    } else {
      result.promo_swept = Number((sweep as Record<string, unknown>)?.total_swept ?? 0);
    }
  } catch (err) {
    result.errors.push(`promo sweep: ${(err as Error).message}`);
  }

  return c.json({
    ok: result.errors.length === 0,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    ...result,
  });

  } finally {
    inFlightSinceMs = null;
  }
}
