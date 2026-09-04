/**
 * Supabase client — service-role, server-side only.
 * Identical pattern to World Hub's src/lib/supabaseServerClient.js
 * lazy-init to prevent module-scope env var crashes when envs haven't
 * loaded yet (e.g., during Docker boot).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

/**
 * Per-request ceiling for every PostgREST call this process makes.
 *
 * WHY (2026-09-04). The collusion scan gave its READ a wall-clock budget and
 * nothing else - not the horse lookup, not the findings insert, not the RPC
 * that advances the mark. This client had no timeout of any kind, so a call
 * that never came back hung the whole handler forever. The symptom is a row
 * stuck at `running` in cron_execution_log with no error, no log line and no
 * clue which call it was on, until the stale sweeper marks it `killed` half an
 * hour later. That is the same shape as the outage this scan was rewritten to
 * fix, one layer down: not slow, never finished, and nothing said so.
 *
 * Twenty seconds is far above anything measured here - the slowest observed
 * PostgREST call in this workload is a 300-id profiles lookup at 695ms, and a
 * 1,000-row page of hand_history is under 900ms from a laptop - and far below
 * the dispatcher's 120s client timeout, so a stuck call now surfaces as a
 * failed run inside the window the dispatcher is watching.
 *
 * IT TIMES OUT, IT NEVER RETRIES. An aborted request may already have
 * executed on the server, and replaying a write is a money-integrity hazard
 * (Club Arena CLAUDE.md section 2, the PGRST002 note: retry only
 * pre-execution 503s, never anything that may have run). A timeout here is a
 * loud failure, which is the whole point; it is not a recovery.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Read at CALL time, not at import time. A constant evaluated when the module
 * first loads is read before anything can set it - which is how the first
 * version of the test for this passed a 40ms override to a client that was
 * still using 20 seconds, and hung.
 */
function requestTimeoutMs(): number {
  const raw = Number(process.env.SUPABASE_REQUEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REQUEST_TIMEOUT_MS;
}

type FetchInput = Parameters<typeof fetch>[0];

async function fetchWithTimeout(input: FetchInput, init?: RequestInit): Promise<Response> {
  const ms = requestTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      const url =
        typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
      // Say WHICH call and for HOW LONG. The whole reason this exists is that
      // the previous failure mode named neither.
      throw new Error(
        `supabase request exceeded ${ms}ms and was aborted: ` +
          `${url.split('?')[0]}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function getSupabase(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error('[supabase] SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) not set');
  if (!key) throw new Error('[supabase] SUPABASE_SERVICE_ROLE_KEY not set');

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithTimeout },
  });
  return cached;
}
