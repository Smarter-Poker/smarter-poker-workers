import { createHash } from 'node:crypto';
import { getSupabase } from './supabase.js';

export class OperationalAlertDeliveryError extends Error {
  constructor(message: string) {
    super(`Operational alert was not recorded: ${message}`);
    this.name = 'OperationalAlertDeliveryError';
  }
}

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
  try {
    const { data, error } = await getSupabase().rpc('fn_record_operational_alert', {
      p_source: event.source,
      p_event_key: event.eventKey,
      p_alertname: event.alertname,
      p_status: event.status,
      p_severity: event.severity,
      p_payload: event.payload,
    });
    if (error) throw new Error(error.message);
    const receipt = String(data ?? '');
    if (!/^[1-9]\d*$/.test(receipt)) throw new Error('queue returned no event receipt');
    return receipt;
  } catch (error) {
    throw new OperationalAlertDeliveryError(error instanceof Error ? error.message : String(error));
  }
}
