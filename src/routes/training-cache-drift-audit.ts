/**
 * GET/POST /cron/training-cache-drift-audit
 *
 * Runs the database-owned audit for the canonical Training question cache.
 * The RPC verifies content and policy seals, source artifacts, classification,
 * lineage, quarantine state, and event-derived counters. Counter drift is
 * repaired atomically by the database; invalid content is removed from the
 * serving pool.
 *
 * A non-healthy verdict deliberately returns 503. That makes drift visible to
 * Open Claw and cron_execution_log instead of allowing a damaged cache to look
 * like a successful daily job. The RPC is idempotent by UTC run date.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

export const TRAINING_CACHE_AUDIT_RPC = 'fn_training_cache_run_drift_audit';

export interface TrainingCacheAuditResult {
  runDate: string;
  status: 'healthy' | 'warning' | 'critical';
  metrics: Record<string, unknown>;
  findings: unknown[];
  runCount: number;
  startedAt: string;
  completedAt: string;
}

export function isTrainingCacheAuditResult(value: unknown): value is TrainingCacheAuditResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.runDate === 'string' &&
    ['healthy', 'warning', 'critical'].includes(String(row.status)) &&
    !!row.metrics &&
    typeof row.metrics === 'object' &&
    !Array.isArray(row.metrics) &&
    Array.isArray(row.findings) &&
    Number.isInteger(row.runCount) &&
    Number(row.runCount) >= 1 &&
    typeof row.startedAt === 'string' &&
    typeof row.completedAt === 'string'
  );
}

export async function trainingCacheDriftAudit(c: Context) {
  const started = Date.now();

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.rpc(TRAINING_CACHE_AUDIT_RPC, {});

    if (error) {
      console.warn('[training-cache-drift-audit] RPC failed:', error.message);
      return c.json(
        {
          ok: false,
          error: error.message,
          elapsed_ms: Date.now() - started,
        },
        500,
      );
    }

    if (!isTrainingCacheAuditResult(data)) {
      console.warn('[training-cache-drift-audit] RPC returned an invalid result');
      return c.json(
        {
          ok: false,
          error: 'training cache audit returned an invalid result',
          elapsed_ms: Date.now() - started,
        },
        500,
      );
    }

    const ok = data.status === 'healthy';
    if (!ok) {
      console.warn(
        '[training-cache-drift-audit] ' +
          data.status +
          ': ' +
          JSON.stringify({ metrics: data.metrics, findings: data.findings }),
      );
    } else {
      console.log(
        '[training-cache-drift-audit] healthy: ' +
          JSON.stringify({ runDate: data.runDate, metrics: data.metrics }),
      );
    }

    return c.json(
      {
        ok,
        audit: data,
        elapsed_ms: Date.now() - started,
      },
      ok ? 200 : 503,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[training-cache-drift-audit] threw:', message);
    return c.json(
      {
        ok: false,
        error: message,
        elapsed_ms: Date.now() - started,
      },
      500,
    );
  }
}
