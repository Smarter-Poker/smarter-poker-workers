import { getSupabase } from './supabase.js';
import {
  OperationalAlertDeliveryError,
  recordOperationalAlert,
  resolvedTwinEventKey,
} from './operationalAlerts.js';

export interface OpenAlertRow {
  event_key: string;
  alertname: string;
  status: string;
  payload: Record<string, unknown>;
  received_at?: string | null;
  last_received_at?: string | null;
}

export interface ResolveOpenAlertsOptions {
  source: string;
  alertnames: readonly string[];
  /** Lookback window for open firing rows; default 7 days so ancient closed history is untouched. */
  maxAgeMs?: number;
  /** Maximum rows inspected per alertname; default 50. */
  limitPerAlertname?: number;
  /** Optional predicate to filter which unresolved firing rows should be resolved. */
  shouldResolve?: (row: OpenAlertRow) => boolean;
  /** Builds the resolved twin payload (excluding `resolves`, which is always injected). */
  buildPayload: (row: OpenAlertRow) => Record<string, unknown>;
  nowMs?: number;
}

export interface ResolveOpenAlertsResult {
  resolvedKeys: string[];
  receipts: string[];
  skippedAlreadyResolved: number;
}

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const RESOLVED_SUFFIX = ':resolved';

function isValidRow(value: unknown): value is OpenAlertRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.event_key === 'string' &&
    row.event_key.length > 0 &&
    typeof row.alertname === 'string' &&
    row.alertname.length > 0 &&
    typeof row.status === 'string' &&
    ['firing', 'resolved', 'info'].includes(row.status)
  );
}

function rowTimestampMs(row: OpenAlertRow): number | null {
  const raw = row.last_received_at ?? row.received_at;
  if (typeof raw !== 'string' || !raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Emits idempotent `status: 'resolved'` twins for open `firing` alerts belonging
 * to `source` and `alertnames`.
 *
 * Read-only on `public.operational_alert_events`; writes go exclusively through
 * `recordOperationalAlert`, inserting distinct `:resolved` rows with
 * `payload.resolves = firing.event_key`. Original firing rows and their
 * `investigation_status` are never modified or deleted.
 *
 * Fails closed (`OperationalAlertDeliveryError`) if the inbox cannot be read,
 * returns malformed state, or rejects a resolved twin delivery.
 */
export async function resolveOpenOperationalAlerts(
  options: ResolveOpenAlertsOptions,
): Promise<ResolveOpenAlertsResult> {
  const {
    source,
    alertnames,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    limitPerAlertname = DEFAULT_LIMIT,
    shouldResolve,
    buildPayload,
    nowMs = Date.now(),
  } = options;

  const resolvedKeys: string[] = [];
  const receipts: string[] = [];
  let skippedAlreadyResolved = 0;

  try {
    for (const alertname of alertnames) {
      const { data, error } = await getSupabase()
        .from('operational_alert_events')
        .select('event_key,alertname,status,payload,received_at,last_received_at')
        .eq('source', source)
        .eq('alertname', alertname)
        .order('last_received_at', { ascending: false })
        .limit(limitPerAlertname);

      if (error) throw new Error(error.message);
      if (!Array.isArray(data)) {
        throw new Error(`invalid operational_alert_events response for ${source}/${alertname}`);
      }

      const rows: OpenAlertRow[] = [];
      for (const item of data) {
        if (!isValidRow(item)) {
          throw new Error(`malformed operational_alert_events row for ${source}/${alertname}`);
        }
        rows.push({
          ...item,
          payload:
            item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
              ? item.payload
              : {},
        });
      }

      // Collect every firing event_key that already has a durable resolved twin.
      const alreadyResolved = new Set<string>();
      for (const row of rows) {
        if (row.status !== 'resolved') continue;
        if (typeof row.payload.resolves === 'string' && row.payload.resolves.length > 0) {
          alreadyResolved.add(row.payload.resolves);
        }
        if (row.event_key.endsWith(RESOLVED_SUFFIX)) {
          alreadyResolved.add(row.event_key.slice(0, -RESOLVED_SUFFIX.length));
        }
      }

      const cutoffMs = nowMs - maxAgeMs;
      for (const row of rows) {
        if (row.status !== 'firing') continue;
        if (alreadyResolved.has(row.event_key)) {
          skippedAlreadyResolved += 1;
          continue;
        }
        const ts = rowTimestampMs(row);
        if (ts !== null && ts < cutoffMs) continue;
        if (shouldResolve && !shouldResolve(row)) continue;

        const twinKey = resolvedTwinEventKey(row.event_key);
        const payload = {
          ...buildPayload(row),
          resolves: row.event_key,
        };
        const receipt = await recordOperationalAlert({
          source,
          eventKey: twinKey,
          alertname: row.alertname,
          status: 'resolved',
          severity: 'info',
          payload,
        });
        alreadyResolved.add(row.event_key);
        resolvedKeys.push(row.event_key);
        receipts.push(receipt);
      }
    }
  } catch (error) {
    if (error instanceof OperationalAlertDeliveryError) throw error;
    throw new OperationalAlertDeliveryError(error instanceof Error ? error.message : String(error));
  }

  return { resolvedKeys, receipts, skippedAlreadyResolved };
}
