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

const MAX_EVENT_KEY_LENGTH = 512;
const RESOLVED_SUFFIX = ':resolved';

/**
 * Deterministic resolved-twin key for a firing event_key.
 *
 * `public.fn_record_operational_alert` has `UNIQUE (source, event_key)` and its
 * `ON CONFLICT DO UPDATE` updates only `last_received_at` and `delivery_count` —
 * never `status`. A resolved twin MUST therefore carry a distinct `event_key`
 * (and `payload.resolves = firingEventKey`) so `smarter_private.reliability_ingest_alert`
 * matches `v_member = p_source || ':' || (p_payload->>'resolves')` and resolves
 * the exact firing member without mutating the original firing row.
 */
export function resolvedTwinEventKey(firingEventKey: string): string {
  const trimmed = firingEventKey.trim();
  if (!trimmed) {
    throw new OperationalAlertDeliveryError('firing eventKey must be non-empty');
  }
  const suffixKey = `${trimmed}${RESOLVED_SUFFIX}`;
  if (suffixKey.length <= MAX_EVENT_KEY_LENGTH) return suffixKey;
  return `${operationalEventKey('resolved-twin', trimmed)}${RESOLVED_SUFFIX}`;
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
  if (!event.eventKey || event.eventKey.length > MAX_EVENT_KEY_LENGTH) {
    throw new OperationalAlertDeliveryError('eventKey length out of bounds');
  }
  const requested = event.payload.target_task_id;
  if (requested !== undefined && requested !== OPERATIONAL_ALERT_TARGET_TASK_ID) {
    throw new OperationalAlertDeliveryError('payload names a different target_task_id');
  }
  if (event.status === 'resolved' && event.payload.resolves !== undefined) {
    const resolves = event.payload.resolves;
    if (typeof resolves !== 'string' || !resolves.trim()) {
      throw new OperationalAlertDeliveryError('resolved alert payload.resolves must be a non-empty string');
    }
    if (resolves === event.eventKey) {
      throw new OperationalAlertDeliveryError(
        'resolved alert eventKey must differ from payload.resolves (fn_record_operational_alert ignores status on conflict)',
      );
    }
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
