/**
 * cron_execution_log stale-run sweeper.
 *
 * The /cron/* middleware writes a 'running' row when a job starts and
 * updates it on completion. A container restart (deploy, crash, OOM) kills
 * in-flight jobs, leaving their rows 'running' forever - three such zombies
 * were hand-cleaned on 2026-08-17/18 after deploys. Any row still 'running'
 * after STALE_MS is a corpse: the longest real job (bbj-detect) takes ~7
 * minutes, and a restart wipes all in-process state anyway.
 *
 * Swept at boot and every 10 minutes (boot-only would miss zombies younger
 * than the threshold at startup). Best-effort: observability must never
 * affect job execution.
 */
import { getSupabase } from './supabase.js';

const STALE_MS = 30 * 60_000;
const SWEEP_INTERVAL_MS = 10 * 60_000;

export async function sweepStaleCronRuns(): Promise<number> {
  try {
    const supabase = getSupabase();
    const cutoff = new Date(Date.now() - STALE_MS).toISOString();
    const { data, error } = await supabase
      .from('cron_execution_log')
      .update({ status: 'killed' })
      .eq('status', 'running')
      .lt('started_at', cutoff)
      .select('id');
    if (error) throw new Error(error.message);
    const n = data?.length ?? 0;
    if (n > 0) {
      console.log(`[cron-sweep] marked ${n} stale 'running' rows as killed`);
    }
    return n;
  } catch (err) {
    console.warn('[cron-sweep] failed:', (err as Error).message);
    return 0;
  }
}

export function startCronLogSweeper(): void {
  void sweepStaleCronRuns();
  const t = setInterval(() => void sweepStaleCronRuns(), SWEEP_INTERVAL_MS);
  // Never keep the process alive just for the sweeper.
  if (typeof t.unref === 'function') t.unref();
}
