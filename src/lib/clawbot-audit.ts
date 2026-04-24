/**
 * Minimal ClawBot audit-log helper for the workers repo.
 *
 * Ports src/lib/clawbot.js:logAudit from World Hub — writes one row to
 * clawbot_audit_log per call. Severity levels mirror monolith's enum.
 */
import { getSupabase } from './supabase.js';

export const CLAWBOT_VERSION = '1.0.0';

export type AuditSeverity = 'info' | 'warning' | 'error' | 'critical';

export async function logAudit(
  taskId: string,
  action: string,
  details: Record<string, unknown> | string = {},
  severity: AuditSeverity = 'info',
): Promise<void> {
  try {
    const supabase = getSupabase();
    const payload = typeof details === 'string' ? { message: details } : details;
    const { error } = await supabase.from('clawbot_audit_log').insert({
      task_id: taskId,
      action,
      details: payload,
      severity,
      clawbot_version: CLAWBOT_VERSION,
      created_at: new Date().toISOString(),
    });
    if (error) console.warn('[clawbot-audit] write failed:', error.message);
  } catch (err) {
    console.warn(
      '[clawbot-audit] handled exception:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
