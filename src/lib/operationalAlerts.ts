import { createHash } from 'node:crypto';
import { getSupabase } from './supabase.js';

export class OperationalAlertDeliveryError extends Error {
  constructor(message: string) {
    super(`Operational alert was not recorded: ${message}`);
    this.name = 'OperationalAlertDeliveryError';
  }
}

/**
 * Every operational incident is addressed to the production-alerts fleet.
 * The inbox triages by payload.target_task_id, so a row without it is invisible
 * to the lane that must fix it. This module is the only writer in this service.
 */
export const OPERATIONAL_ALERT_TARGET_TASK_ID = '01a09b86-5ba8-7290-8657-1041f13dd3ca';

/** Stable across retries and processes; never includes credentials or a phone. */
export function operationalEventKey(...identity: Array<string | number>): string {
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

/**
 * Operational incidents belong to the service-only inbox consumed by Codex.
 * A durable receipt is the only acknowledgement. Never fall back to SMS and
 * never let an unrecorded alert advance the caller's cooldown or success state.
 */
export async function recordOperationalAlert(event: {
  source: string;
  eventKey: string;
  alertname: string;
  status: 'firing' | 'resolved';
  severity: 'critical' | 'warning' | 'info';
  payload: Record<string, unknown>;
}): Promise<string> {
  const requested = event.payload.target_task_id;
  if (requested !== undefined && requested !== OPERATIONAL_ALERT_TARGET_TASK_ID) {
    throw new OperationalAlertDeliveryError('payload names a different target_task_id');
  }
  try {
    const { data, error } = await getSupabase().rpc('fn_record_operational_alert', {
      p_source: event.source,
      p_event_key: event.eventKey,
      p_alertname: event.alertname,
      p_status: event.status,
      p_severity: event.severity,
      p_payload: { ...event.payload, target_task_id: OPERATIONAL_ALERT_TARGET_TASK_ID },
    });
    if (error) throw new Error(error.message);
    const receipt = String(data ?? '');
    if (!/^[1-9]\d*$/.test(receipt)) throw new Error('queue returned no event receipt');
    return receipt;
  } catch (error) {
    throw new OperationalAlertDeliveryError(error instanceof Error ? error.message : String(error));
  }
}
