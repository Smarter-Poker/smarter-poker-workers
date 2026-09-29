import type { getSupabase } from './supabase.js';

type SupabaseClient = ReturnType<typeof getSupabase>;

/**
 * The owner account. Operational content - a job fault, a settlement parked
 * for review, a detected rule break - never reaches it as a personal
 * notification. A public.notifications row is mirrored into push_outbox by
 * trg_mirror_notification_to_push_outbox and becomes a push to the owner's
 * phone, and the owner's standing rule is that operational alerts belong in
 * public.operational_alert_events, addressed to the production-alerts fleet
 * (lib/operationalAlerts.ts).
 *
 * The exclusion is for this one account and is never broadened. Every other
 * recipient of an operational notice - a union's own owner and admins, who are
 * that union's business contacts - keeps the personal notification exactly as
 * the sender wrote it, with the marker below added to its data.
 */
export const OWNER_ACCOUNT_ID = '47965354-0e56-43ef-931c-ddaab82af765';

export function isOwnerAccount(userId: string | null | undefined): boolean {
  return typeof userId === 'string' && userId.trim().toLowerCase() === OWNER_ACCOUNT_ID;
}

/**
 * Splits the recipients a sender resolved for an operational notice. The owner
 * account is taken out of the personal list and reported as `ownerCopy`, which
 * the sender must route to the Production Alerts store instead.
 */
export function splitOwnerCopy(recipients: Iterable<string | null | undefined>): {
  personal: string[];
  ownerCopy: boolean;
} {
  const personal = new Set<string>();
  let ownerCopy = false;
  for (const id of recipients) {
    if (typeof id !== 'string' || !id) continue;
    if (isOwnerAccount(id)) ownerCopy = true;
    else personal.add(id);
  }
  return { personal: [...personal], ownerCopy };
}

export class OwnerOperationalNoticeRefused extends Error {
  constructor() {
    super('an operational notice addressed to the owner account was refused before any write; '
      + 'route the owner copy to operational_alert_events');
    this.name = 'OwnerOperationalNoticeRefused';
  }
}

/**
 * What makes an operational notice machine-recognisable, in its `data`: the
 * sender (`component`) and the incident it reports (`alertname`), the shape
 * the Club Arena engine's operational notices already carry. The database
 * classifier public.fn_is_owner_operational_notification (and its World Hub
 * mirror) can match an owner-account copy by it whatever its title says, and
 * fn_try_record_owner_notification files a captured copy under this alertname
 * and severity. Ordinary business statements never carry it.
 */
export interface OperationalNoticeMarker {
  component: string;
  alertname: string;
  severity: 'critical' | 'warning' | 'info';
}

export class OperationalNoticeUnmarked extends Error {
  constructor() {
    super('an operational notice needs a marker (component, alertname, severity) before any write');
    this.name = 'OperationalNoticeUnmarked';
  }
}

function isMarker(marker: unknown): marker is OperationalNoticeMarker {
  if (!marker || typeof marker !== 'object') return false;
  const m = marker as Record<string, unknown>;
  return typeof m.component === 'string' && m.component.trim().length > 0
    && typeof m.alertname === 'string' && m.alertname.trim().length > 0
    && (m.severity === 'critical' || m.severity === 'warning' || m.severity === 'info');
}

export interface OperationalNoticeRow {
  user_id: string;
  type: string;
  title: string;
  message: string;
  data: Record<string, unknown>;
  read: false;
}

/**
 * The only way a workers sender writes an OPERATIONAL notice (a fault, a parked
 * settlement, a rule break) into public.notifications. A batch that addresses
 * the owner account is refused whole, before anything is written, so no sender
 * can put operational content on the owner's phone even if its own recipient
 * filtering regresses. Every row it writes carries the sender's marker in its
 * data, so the database layer can recognise the notice as operational from the
 * row alone. Ordinary business statements (commission received, settlement
 * complete, rakeback received) are not operational and do not use this path.
 */
export async function insertOperationalNotices(
  supabase: SupabaseClient,
  marker: OperationalNoticeMarker,
  rows: OperationalNoticeRow[],
): Promise<{ inserted: number; error: string | null }> {
  if (rows.some((row) => isOwnerAccount(row.user_id))) throw new OwnerOperationalNoticeRefused();
  if (!isMarker(marker)) throw new OperationalNoticeUnmarked();
  if (rows.length === 0) return { inserted: 0, error: null };
  const marked = rows.map((row) => ({
    ...row,
    data: { ...row.data, component: marker.component, alertname: marker.alertname, severity: marker.severity },
  }));
  const { error } = await supabase.from('notifications').insert(marked);
  return error ? { inserted: 0, error: error.message } : { inserted: rows.length, error: null };
}
