import type { getSupabase } from './supabase.js';
import {
  OPERATIONAL_ALERT_TARGET_TASK_ID,
  OperationalAlertDeliveryError,
  operationalEventKey,
  recordOperationalAlert,
} from './operationalAlerts.js';
import { OWNER_ACCOUNT_ID, type OperationalNoticeMarker } from './ownerOperationalRouting.js';

type SupabaseClient = ReturnType<typeof getSupabase>;

/**
 * Production Alerts route for the weekly settlement's problem notices
 * (routes/auto-settlement.ts, notifyUnionSettlementProblem).
 *
 * Those notices are operational: a job fault, a player P&L run parked for
 * review, a live rule break. The owner account's copy of each one is recorded
 * here, in public.operational_alert_events addressed to the fleet, instead of
 * as a personal notification that the push mirror sends to that account's
 * phone. Every recovery takes the same route as its fault.
 *
 * One incident per condition. Each incident is one fact that is true or false
 * at every run: a union's weekly player P&L of one kind (failed, or parked for
 * review) has windows its calls left unsettled; a platform rule invariant is
 * critically broken; a leaked problem notice's original is not yet preserved
 * for the fleet; a problem push is queued for the phone. While the fact holds,
 * a re-run coalesces into the open incident. The first run that proves the
 * fact false records the recovery, which names the incident: settled
 * union_pnl_settlements rows, from this job or any other path, that cover
 * every window the incident holds with no gap; a complete check without the
 * invariant; the notice's original in operational_notification_destinations
 * for the fleet, with its store receipt; a push that ended undelivered. An
 * incident never closes because its harm ran its course. After a recovery, or
 * after the fleet closed the incident, a recurrence is a new incident: the
 * next link of that condition's chain.
 *
 * Nothing here writes chips, ledgers or settlement rows. Its settlement reads
 * (a union's union_pnl_settlements rows, for a fault's window and for a
 * recovery's proof) are read-only selects, after the run's last money call.
 */
export const SETTLEMENT_ALERT_SOURCE = 'workers.auto-settlement';
const JOB = '/cron/auto-settlement';

export const SETTLEMENT_PROBLEMS = {
  pnl_needs_review: {
    alertname: 'UnionPlayerPnlNeedsReview',
    severity: 'warning',
    title: 'Weekly player P&L needs review',
  },
  pnl_failed: { alertname: 'UnionPlayerPnlFailed', severity: 'critical', title: 'Weekly player P&L failed' },
  rule_violation: { alertname: 'UnionRuleViolation', severity: 'critical', title: 'Union rule violation detected' },
} as const;
export type SettlementProblemKind = keyof typeof SETTLEMENT_PROBLEMS;
const PROBLEM_KINDS = Object.keys(SETTLEMENT_PROBLEMS) as SettlementProblemKind[];

/**
 * The marker in the data of every settlement problem notice this route writes
 * (lib/ownerOperationalRouting.ts stamps it on each row). With the titles it is
 * the whole settlement clause of the database classifier: see
 * SETTLEMENT_PROBLEM_CLASSIFIER.
 */
export function problemNoticeMarker(kind: SettlementProblemKind): OperationalNoticeMarker {
  const problem = SETTLEMENT_PROBLEMS[kind];
  return { component: SETTLEMENT_ALERT_SOURCE, alertname: problem.alertname, severity: problem.severity };
}

/**
 * A title as every settlement problem check compares it: ASCII letters in
 * lower case, each run of ASCII whitespace one space, the ends trimmed. Only
 * ASCII is folded, so the rule is exactly the same in SQL:
 *   btrim(regexp_replace(translate(title, 'ABC...Z', 'abc...z'), E'[\\t\\n\\v\\f\\r ]+', ' ', 'g'), ' ')
 */
export function normalizeTitle(title: string): string {
  return title
    .replace(/[A-Z]+/g, (letters) => letters.toLowerCase())
    .replace(/[\t\n\v\f\r ]+/g, ' ')
    .replace(/^ | $/g, '');
}

/**
 * What counts as a settlement problem notice, here and in the database
 * classifier public.fn_is_owner_operational_notification (and its World Hub
 * mirror): type `settlement`, and a normalized title that is one of the three
 * problem titles, or data carrying this route's marker (`component` and one
 * of these `alertname`s). The three owner-account rows written before the
 * marker existed carry only the title.
 */
export const SETTLEMENT_PROBLEM_CLASSIFIER = {
  type: 'settlement',
  normalizedTitles: PROBLEM_KINDS.map((kind) => normalizeTitle(SETTLEMENT_PROBLEMS[kind].title)),
  component: SETTLEMENT_ALERT_SOURCE,
  alertnames: PROBLEM_KINDS.map((kind) => SETTLEMENT_PROBLEMS[kind].alertname as string),
};

const KIND_BY_TITLE = new Map(PROBLEM_KINDS.map((kind) => [normalizeTitle(SETTLEMENT_PROBLEMS[kind].title), kind]));
const KIND_BY_ALERTNAME = new Map(PROBLEM_KINDS.map((kind) => [SETTLEMENT_PROBLEMS[kind].alertname as string, kind]));

export function problemKindOfTitle(title: unknown): SettlementProblemKind | null {
  return typeof title === 'string' ? KIND_BY_TITLE.get(normalizeTitle(title)) ?? null : null;
}

export function problemKindOfMarker(data: unknown): SettlementProblemKind | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.component !== SETTLEMENT_ALERT_SOURCE || typeof d.alertname !== 'string') return null;
  return KIND_BY_ALERTNAME.get(d.alertname) ?? null;
}

/** The problem a notification row (or a push row, with `type` its event) reports, or null. */
export function settlementProblemKind(row: { type?: unknown; title?: unknown; data?: unknown }): SettlementProblemKind | null {
  if (row.type !== SETTLEMENT_PROBLEM_CLASSIFIER.type) return null;
  return problemKindOfMarker(row.data) ?? problemKindOfTitle(row.title);
}

/**
 * Server-side ILIKE patterns, one per problem title: its words in order with
 * wildcards between. Each matches every title that normalizes to its problem
 * title, so a read filtered by them returns everything the client check keeps.
 * They hold only letters and `*`, which PostgREST never reserves inside or=(...).
 */
export const PROBLEM_TITLE_PATTERNS = PROBLEM_KINDS
  .map((kind) => `*${SETTLEMENT_PROBLEMS[kind].title.toLowerCase().split(/[^a-z]+/).filter(Boolean).join('*')}*`);
const PROBLEM_PUSH_FILTER = PROBLEM_TITLE_PATTERNS.map((pattern) => `title.ilike.${pattern}`).join(',');
const PROBLEM_NOTICE_FILTER = [
  PROBLEM_PUSH_FILTER,
  ...SETTLEMENT_PROBLEM_CLASSIFIER.alertnames.map((alertname) => `data->>alertname.eq.${alertname}`),
].join(',');

/**
 * A settlement problem notice that reached the owner account's personal inbox.
 * Open until the notice has left the inbox with its original preserved for
 * the fleet in operational_notification_destinations.
 */
export const OWNER_INBOX_LEAK = {
  alertname: 'OwnerSettlementNoticeReachedPersonalInbox',
  severity: 'critical',
} as const;
/** A settlement problem push queued for the owner account's phone. */
export const OWNER_PHONE_LEAK = {
  alertname: 'OwnerSettlementPushQueuedForPhone',
  severity: 'critical',
} as const;

/** Investigation states in which the fleet has finished with an incident. */
const NOT_OPEN = ['verified_fixed', 'historical', 'test'];
const NOT_OPEN_SET = new Set(NOT_OPEN);
/**
 * Rows per page. Every read is paged on a keyset of `id` until a short page
 * ends it (see MAX_PAGES). 200 is under PostgREST's db-max-rows (1000), so a
 * short page really is the end.
 */
export const PAGE_ROWS = 200;
/**
 * Pages per read. A read whose MAX_PAGES pages all come back full (10,000 or
 * more matching rows) fails the step loudly and decides nothing: a full last
 * page cannot prove there is no more.
 */
export const MAX_PAGES = 50;
/** Keys per `in` list, so a request line stays short. */
const KEY_CHUNK = 50;
const STORE_COLUMNS = 'id,event_key,alertname,status,investigation_status,received_at,last_received_at,delivery_count,payload';

/** Rows whose period_end anchors fn_union_settle_player_pnl_weekly's next window. */
const PNL_CHAIN_STATUSES: ReadonlySet<string> = new Set(['settled', 'baseline']);
/** The only rows that settled their span. A baseline skips its span; it settles nothing. */
const PNL_SETTLED_STATUSES: ReadonlySet<string> = new Set(['settled']);
/** A call parked for review wrote its window as needs_review; a re-run of the period supersedes it. */
const PNL_PARKED_STATUSES: ReadonlySet<string> = new Set(['needs_review', 'superseded']);
/** With no chain row, fn_union_settle_player_pnl_weekly settles from now() - 7 days. */
const PNL_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How long before the run started a chain row must have ended, and been
 * written, to be one the failed call certainly could see, and how long after
 * the fault one written then may still have been seen. It covers a database
 * clock behind or ahead of the worker's and a baseline reset from a
 * transaction that began shortly before the run. It assumes that every
 * transaction writing a union_pnl_settlements row finishes within it, and
 * that the worker's and the database's clocks differ by less than it. Beyond
 * those bounds a row the call never saw can pass for its anchor, and an
 * incident can close falsely.
 */
export const ANCHOR_MARGIN_MS = 10 * 60 * 1000;
/** A push the dispatcher has not finished with: it claims pending rows, then marks them processing. */
const QUEUED_PUSH_STATUSES = ['pending', 'processing'];

export type SettlementProblemEvidence =
  | { kind: 'pnl_needs_review'; reason: string | null; settlement_id: string | null }
  | { kind: 'pnl_failed'; error: { message: string; code: string | null } }
  | {
      kind: 'rule_violation';
      violations: Array<{ invariant: string; severity: string; offenders: number }>;
    };
type PnlEvidence = Exclude<SettlementProblemEvidence, { kind: 'rule_violation' }>;
export type PnlProblemKind = PnlEvidence['kind'];
type Violation = { invariant: string; severity: string; offenders: number };

export interface StoreRow {
  id?: number | string;
  event_key: string;
  alertname: string;
  status: string;
  investigation_status: string;
  received_at: string;
  last_received_at: string;
  delivery_count?: number | string;
  payload: Record<string, unknown> | null;
}

interface FaultIntent {
  unionId: string;
  unionName: string | null;
  evidence: SettlementProblemEvidence;
  recipientsUnknown: boolean;
  otherRecipientsNotified: number;
  occurredAt: number;
}

/**
 * fn_union_governance_check and fn_settlement_conservation_check are
 * platform-wide: one broken invariant is one incident, whichever unions' owner
 * copies reported it (or none could be read).
 */
const PLATFORM_SCOPE = 'platform';

const iso = (ms: number) => new Date(ms).toISOString();
const TEXT_LIMIT = 500;

/** The settlement week of a run: the UTC date of the Monday that starts it. */
export function settlementWeek(ms: number): string {
  const d = new Date(ms);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday))
    .toISOString()
    .slice(0, 10);
}

/** Identity of one problem of one kind about one condition (a union's unsettled P&L windows, an invariant). */
export function faultBaseKey(kind: SettlementProblemKind, unionId: string, condition: readonly string[]): string {
  return operationalEventKey('union-settlement', kind, unionId, ...condition);
}

/** Identity of one leaked notice or queued push. */
export function leakBaseKey(leak: 'notification' | 'push', id: string): string {
  return operationalEventKey('owner-inbox-leak', leak, id);
}

/** Link `n` of a condition's chain: the base itself, then `<base>:r1`, `<base>:r2`, ... */
export function linkKey(base: string, link: number): string {
  return link === 0 ? base : `${base}:r${link}`;
}

export function resolutionKey(faultKey: string): string {
  return `${faultKey}:resolved`;
}

/** The base of a link or resolution key (bases are hex digests, so they hold no colon). */
function baseOf(key: string): string {
  return key.split(':')[0] as string;
}

function clip(text: string): string {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}...` : text;
}

/**
 * The message and code of a thrown value. A PostgREST error is a plain object,
 * not an Error, so String() of it is "[object Object]" - which is all the
 * owner account's "Weekly player P&L failed" notices said.
 */
export function errorEvidence(err: unknown): { message: string; code: string | null } {
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    const message = typeof o.message === 'string' && o.message ? o.message : String(err);
    return { message: clip(message), code: typeof o.code === 'string' && o.code ? o.code : null };
  }
  return { message: clip(String(err)), code: null };
}

/**
 * A union_pnl_settlements row, as read (any status). settled_at is when it was
 * written: now() of the writing transaction (the column default, and what
 * fn_union_settle_player_pnl sets when it settles), on the database clock.
 */
export interface SettlementRow {
  id?: unknown;
  status?: unknown;
  period_start?: unknown;
  period_end?: unknown;
  settled_at?: unknown;
}

/** A row's span; `written` is its settled_at, NaN when that cannot be read. */
interface Span { id: string; start: number; end: number; written: number; row: SettlementRow }

function spansOf(rows: SettlementRow[], statuses: ReadonlySet<string>): Span[] {
  const spans: Span[] = [];
  for (const row of rows) {
    if (!statuses.has(String(row.status))) continue;
    const start = Date.parse(String(row.period_start));
    const end = Date.parse(String(row.period_end));
    const written = Date.parse(String(row.settled_at));
    if (Number.isFinite(start) && Number.isFinite(end)) spans.push({ id: String(row.id), start, end, written, row });
  }
  return spans;
}

/**
 * Whether a union's settled union_pnl_settlements rows cover [startMs, endMs]
 * with no gap, by this job or by any other path (World Hub settle-period.js
 * settles by hand from a club period's start, and a parked period can be
 * re-run by hand). Only status `settled` counts: a parked, skipped or failed
 * call leaves no settled row, and a baseline skips its span rather than
 * settling it. `coveredBy` names the rows that carry the cover, in order.
 */
export function settledCoverage(
  rows: SettlementRow[],
  startMs: number,
  endMs: number,
): { covered: boolean; coveredBy: string[] } {
  const settled = spansOf(rows, PNL_SETTLED_STATUSES).sort((a, b) => a.start - b.start);
  const coveredBy: string[] = [];
  let reached = startMs;
  for (const row of settled) {
    if (row.start > reached) break;
    if (row.end > reached) {
      reached = row.end;
      coveredBy.push(row.id);
    }
  }
  return { covered: coveredBy.length > 0 && reached >= endMs, coveredBy };
}

export interface InboxNotice { id: unknown; type?: unknown; title?: unknown; data?: unknown; created_at?: unknown }
export interface OutboxPush {
  id: unknown;
  event?: unknown;
  title?: unknown;
  status?: unknown;
  related_entity_id?: unknown;
  created_at?: unknown;
}

export type PushOutcome = 'queued' | 'delivered' | 'undelivered' | 'unknown';

/** push_outbox.status (pending, processing, sent, failed, skipped) as what it means for the phone. */
export function pushOutcome(status: unknown): PushOutcome {
  if (status === 'pending' || status === 'processing') return 'queued';
  if (status === 'sent') return 'delivered';
  if (status === 'skipped' || status === 'failed') return 'undelivered';
  return 'unknown';
}

/**
 * What a complete read found: settlement problem notices in the owner
 * account's personal inbox, and settlement problem pushes still queued for
 * its phone. A push that was already delivered or dropped is history.
 */
export function presentLeaks<N extends InboxNotice, P extends OutboxPush>(
  notes: N[],
  pushes: P[],
): { notes: N[]; pushes: P[] } {
  return {
    notes: notes.filter((note) => settlementProblemKind(note) !== null),
    pushes: pushes.filter((push) => pushOutcome(push.status) === 'queued'
      && settlementProblemKind({ type: push.event, title: push.title }) !== null),
  };
}

/**
 * One player P&L incident per union and kind at a time. It holds every window
 * the union's calls of that kind left unsettled while it is open: a union's
 * windows follow one another along its chain, and the window of a fault
 * cannot always be read when it happens. So no window is ever held by two open
 * incidents, and a fault whose window is unknown is never left beside the
 * incident of the window it turns out to be.
 */
export function pnlIncidentBaseKey(kind: PnlProblemKind, unionId: string): string {
  return faultBaseKey(kind, unionId, ['unsettled-windows']);
}

export type PnlWindowBasis = 'parked_row' | 'chain_anchor' | 'anchor_moved' | 'no_anchor';
export interface PnlWindowStart {
  /** The earliest start the call's window can have had. */
  startMs: number;
  /** That start as the row stores it (microseconds included), or as computed. */
  startText: string | null;
  basis: PnlWindowBasis;
  /** The parked row, or the chain row the call certainly could see (within the ANCHOR_MARGIN_MS bounds). */
  anchorId: string | null;
  /** Chain rows the call may or may not have seen: written, or ended, within the margin of its run, or during it. */
  movedBy: string[];
}

const isoOrNull = (ms: number) => (Number.isFinite(ms) ? iso(ms) : null);

/**
 * The earliest start the window of a weekly player P&L call, made during a run
 * that started at runStartedAtMs, can have had. fn_union_settle_player_pnl_weekly
 * starts it at the period_end of the union's latest settled or baseline row (by
 * period_start) that it can see, and with no such row at now() - 7 days.
 * - A call parked for review recorded its own window: its parked row's
 *   period_start is exact ('parked_row').
 * - Otherwise the anchor is taken as of the run: a chain row that ended, and
 *   was written (settled_at), at least ANCHOR_MARGIN_MS before the run started
 *   is one the call could see (within the bounds ANCHOR_MARGIN_MS assumes),
 *   and the latest of those (by period_start) is 'chain_anchor'.
 * - A later chain row, written and ended no later than ANCHOR_MARGIN_MS after
 *   the fault, may or may not have been visible to the call: written during
 *   the run, by a transaction that began shortly before it, or stamped by a
 *   database clock behind or ahead of the worker's. The call then settled
 *   from the anchor or from such a row, and nothing recorded tells which, so
 *   the earliest start any of them gives is the start a recovery must prove
 *   ('anchor_moved').
 * - A chain row written later than that is one the call cannot have seen,
 *   within the same bounds, whatever span it names: a settlement made
 *   afterwards, by hand, for a past span never becomes the anchor of an
 *   earlier call.
 * - With no anchor, the call's own fallback, taken no later than the run start
 *   less the margin and 7 days ('no_anchor'), or a row it may have seen.
 */
export function pnlWindowStart(
  rows: SettlementRow[],
  runStartedAtMs: number,
  occurredAtMs: number,
  parkedId: string | null = null,
): PnlWindowStart {
  if (parkedId !== null) {
    const parked = rows.find((row) => String(row.id) === parkedId);
    const start = parked ? Date.parse(String(parked.period_start)) : Number.NaN;
    if (parked && Number.isFinite(start)) {
      return { startMs: start, startText: String(parked.period_start), basis: 'parked_row', anchorId: parkedId, movedBy: [] };
    }
  }
  const cut = runStartedAtMs - ANCHOR_MARGIN_MS;
  const horizon = occurredAtMs + ANCHOR_MARGIN_MS;
  const chain = spansOf(rows, PNL_CHAIN_STATUSES);
  let anchor: Span | null = null;
  for (const row of chain) {
    if (row.end <= cut && row.written <= cut && (!anchor || row.start > anchor.start)) anchor = row;
  }
  const after = anchor ? anchor.start : Number.NEGATIVE_INFINITY;
  // No row the call certainly saw starts later than the anchor. A write time
  // that cannot be read counts as one the call may have seen.
  const moved = chain.filter((row) => row.start > after && row.end <= horizon && !(row.written > horizon));
  let startMs = anchor ? anchor.end : cut - PNL_FALLBACK_MS;
  let startText = anchor ? String(anchor.row.period_end) : isoOrNull(startMs);
  for (const row of moved) {
    if (row.end < startMs) {
      startMs = row.end;
      startText = String(row.row.period_end);
    }
  }
  return {
    startMs,
    startText,
    basis: moved.length > 0 ? 'anchor_moved' : anchor ? 'chain_anchor' : 'no_anchor',
    anchorId: anchor ? anchor.id : null,
    movedBy: moved.map((row) => row.id),
  };
}

export interface PnlRecoveryRequirement {
  window: PnlWindowStart;
  /** Where the proof starts: the earliest start the incident's first window can have had. */
  startMs: number;
  startText: string | null;
  /** How that start is known: a PnlWindowBasis, or the basis recorded with the fault when that start is earlier. */
  startBasis: string;
  /** Where the proof must reach: see endBasis. */
  endMs: number;
  /**
   * 'parked_row': the end of the last parked row, exact. 'last_record': the
   * store's own time of the incident's last record (received_at, or
   * last_received_at once a re-run joined it), later than the end of every
   * window the incident holds.
   */
  endBasis: 'parked_row' | 'last_record';
  lastOccurrenceMs: number;
  occurrences: number;
}

/**
 * What the recovery of a player P&L incident must prove: settled rows with no
 * gap from the earliest start its first window can have had through the end
 * of its last window. A union's windows follow one another along its chain,
 * so every later occurrence's window lies inside that span, and one cover
 * proves them all: the proof of an earlier window alone never closes an
 * incident that holds a later one.
 * - The start: the first window's, as of the first run (pnlWindowStart), and
 *   never later than the start recorded when it happened.
 * - The end: a call parked for review recorded where its window ended, so it
 *   is the period_end of the last parked row written while the incident was
 *   open, exact (a re-run of that very period proves it). Otherwise the time
 *   the store recorded the incident's last occurrence: the store's record
 *   function stamps received_at, and last_received_at when a re-run joins,
 *   with clock_timestamp(), the database clock that stamps settled_at and a
 *   weekly call's period_end. A window runs up to its call's own now(), and
 *   every call returned before its run recorded the fault, so every window
 *   the incident holds ended before that time. A weekly settlement begun
 *   after it (a re-run, or next week's) ends after it; one that ended before
 *   it may have been the failed call's own anchor, and proves nothing until
 *   the chain extends past that time.
 */
export function pnlRecoveryRequirement(fault: StoreRow, rows: SettlementRow[]): PnlRecoveryRequirement {
  const payload = fault.payload ?? {};
  const first = occurredAt(fault);
  const occurrences = Math.max(1, Number(fault.delivery_count ?? 1) || 1);
  const last = occurrences > 1 ? Math.max(first, Date.parse(String(fault.last_received_at))) : first;
  const recordedRun = Date.parse(String(payload.run_started_at ?? ''));
  const parkedId = payload.kind === 'pnl_needs_review' && typeof payload.settlement_id === 'string'
    && payload.settlement_id !== '' ? payload.settlement_id : null;
  const window = pnlWindowStart(rows, Number.isFinite(recordedRun) ? recordedRun : first, first, parkedId);
  const recorded = Date.parse(String(payload.window_start ?? ''));
  const useRecorded = Number.isFinite(recorded) && !(recorded >= window.startMs);
  // A time that cannot be read makes the end NaN, which no cover reaches.
  let endMs = Math.max(Date.parse(String(fault.received_at)), Date.parse(String(fault.last_received_at)));
  let endBasis: PnlRecoveryRequirement['endBasis'] = 'last_record';
  if (window.basis === 'parked_row') {
    const parkedEnds = spansOf(rows, PNL_PARKED_STATUSES)
      .filter((row) => row.end >= first - ANCHOR_MARGIN_MS && row.end <= last + ANCHOR_MARGIN_MS)
      .map((row) => row.end);
    if (parkedEnds.length > 0) {
      endMs = Math.max(...parkedEnds);
      endBasis = 'parked_row';
    }
  }
  return {
    window,
    startMs: useRecorded ? recorded : window.startMs,
    startText: useRecorded ? String(payload.window_start) : window.startText,
    startBasis: useRecorded ? `recorded ${String(payload.window_basis ?? 'window')}` : window.basis,
    endMs,
    endBasis,
    lastOccurrenceMs: last,
    occurrences,
  };
}

/**
 * The link of a condition's chain that a firing record goes to: the open
 * incident while there is one (a re-run coalesces into it), otherwise the
 * first unused link. A recurrence after a recorded recovery, or after the
 * fleet closed the incident, is a new incident and never bumps the old row.
 * `chain` is every store row whose key starts with `base`.
 */
export function chooseFaultKey(base: string, chain: StoreRow[]): string {
  const resolved = new Set(chain.filter((r) => r.status === 'resolved').map((r) => r.event_key));
  const used = new Set<number>();
  let open: { link: number; key: string } | null = null;
  for (const row of chain) {
    const recovery = row.status === 'resolved' && row.event_key.endsWith(':resolved');
    const link = linkOf(base, recovery ? row.event_key.slice(0, -':resolved'.length) : row.event_key);
    if (link === null) continue;
    used.add(link);
    if (row.status !== 'firing' || NOT_OPEN_SET.has(row.investigation_status)
      || resolved.has(resolutionKey(row.event_key))) continue;
    if (!open || link < open.link) open = { link, key: row.event_key };
  }
  if (open) return open.key;
  let link = 0;
  while (used.has(link)) link += 1;
  return linkKey(base, link);
}

/** The link number of a key in `base`'s chain, or null for a key outside it. */
function linkOf(base: string, key: string): number | null {
  if (key === base) return 0;
  if (!key.startsWith(`${base}:r`)) return null;
  const link = /^[1-9]\d*$/.exec(key.slice(base.length + 2));
  return link ? Number(link[0]) : null;
}

function occurredAt(row: StoreRow): number {
  const stamped = Date.parse(String(row.payload?.occurred_at ?? ''));
  return Number.isFinite(stamped) ? stamped : Date.parse(row.received_at);
}

/** Faults neither recovered nor finished by the fleet. */
export function openFaults(rows: StoreRow[]): StoreRow[] {
  const resolved = new Set(rows.filter((r) => r.status === 'resolved').map((r) => r.event_key));
  return rows.filter((r) => r.status === 'firing' && !NOT_OPEN_SET.has(r.investigation_status)
    && !resolved.has(resolutionKey(r.event_key)));
}

/**
 * The open rule-violation faults a complete run of both governance checks
 * clears: those whose invariant it no longer reports as critical. A fault
 * that names no invariant is cleared only by a run with no critical row.
 */
export function ruleFaultsCleared(rows: StoreRow[], critical: ReadonlySet<string>, checkedAtMs: number): StoreRow[] {
  return openFaults(rows).filter((fault) => {
    if (occurredAt(fault) > checkedAtMs) return false;
    const invariant = fault.payload?.invariant;
    return typeof invariant === 'string' ? !critical.has(invariant) : critical.size === 0;
  });
}

/** One entry per invariant: the conservation check can report the same issue once per offender. */
export function distinctViolations(violations: Violation[]): Violation[] {
  const byInvariant = new Map<string, Violation>();
  for (const violation of violations) {
    const seen = byInvariant.get(violation.invariant);
    if (!seen) {
      byInvariant.set(violation.invariant, { ...violation });
      continue;
    }
    const add = Number.isFinite(violation.offenders) ? violation.offenders : 0;
    seen.offenders = (Number.isFinite(seen.offenders) ? seen.offenders : 0) + add;
  }
  return [...byInvariant.values()];
}

type Page = PromiseLike<{ data: unknown; error: { message: string } | null }>;

/**
 * Every row a filtered read matches, paged on a keyset of `id` (a total
 * order). `page(after)` must build a fresh query each call - a PostgREST
 * builder is a one-shot thenable - ordered by id and limited to PAGE_ROWS.
 * It throws, deciding nothing, when all MAX_PAGES pages come back full.
 */
export async function readPages<T extends { id?: unknown }>(what: string, page: (after: unknown) => Page): Promise<T[]> {
  const rows: T[] = [];
  let after: unknown = null;
  for (let n = 0; n < MAX_PAGES; n += 1) {
    const { data, error } = await page(after);
    if (error) throw new OperationalAlertDeliveryError(`cannot read ${what}: ${error.message}`);
    if (!Array.isArray(data)) throw new OperationalAlertDeliveryError(`${what}: the read returned no rows array`);
    rows.push(...(data as T[]));
    if (data.length < PAGE_ROWS) return rows;
    after = (data[data.length - 1] as T).id;
    if (after === undefined || after === null) {
      throw new OperationalAlertDeliveryError(`${what}: a row came back without an id`);
    }
  }
  throw new OperationalAlertDeliveryError(`${what}: ${MAX_PAGES * PAGE_ROWS} or more rows match; cannot decide`);
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += KEY_CHUNK) out.push(items.slice(i, i + KEY_CHUNK));
  return out;
}

/**
 * One run's Production Alerts copy of the settlement problem notices. The route
 * queues while it settles and calls flush() once, after its last money call, so
 * no alert I/O sits between one union's player P&L and the next. flush() never
 * throws: every failure is kept in `failures`, and the route answers HTTP 500
 * (retryable: false once money moved) rather than falling back to the owner's
 * inbox. A copy whose store step failed is not kept anywhere else: that run's
 * copy is lost, and the fleet sees the condition only if the next run finds it
 * still true. A failure in routing a notice (routingFailed) fails the run the
 * same way, and the owner copy of that notice is still recorded.
 */
export class SettlementAlerts {
  readonly outcomes: Array<Record<string, unknown>> = [];
  readonly failures: string[] = [];
  private readonly faults: FaultIntent[] = [];
  private rulesCheck: { at: number; critical: Set<string> } | null = null;
  private readonly week: string;
  /** Each union's union_pnl_settlements rows, read once per flush, after the last money call. */
  private readonly settlementRows = new Map<string, SettlementRow[]>();

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly runStartedAt: number,
  ) {
    this.week = settlementWeek(runStartedAt);
  }

  /** The owner account's copy of a settlement problem notice (or one whose recipients could not be read). */
  ownerCopy(intent: Omit<FaultIntent, 'occurredAt'>): void {
    this.faults.push({ ...intent, occurredAt: Date.now() });
  }

  /**
   * Both governance checks ran to completion. `critical` names every invariant
   * they reported as critical; every other open rule-violation incident is
   * over.
   */
  rulesChecked(critical: Iterable<string>): void {
    this.rulesCheck = { at: Date.now(), critical: new Set(critical) };
  }

  /**
   * A failure of this run's routing of a problem notice, such as the guard
   * refusing a batch that addressed the owner account. It is kept with the
   * alert phase's failures, so the run answers HTTP 500 (retryable: false once
   * money moved), as for a failed store write; it is never swallowed.
   */
  routingFailed(message: string): void {
    this.failures.push(message);
    console.warn('[auto-settlement] problem notice routing failed:', message);
  }

  /**
   * Recoveries first, so an incident this run proves over is closed before a
   * fault of the same union and kind would join it; then this run's faults;
   * then detection.
   */
  async flush(): Promise<void> {
    await this.attempt(() => this.recordPnlRecoveries());
    const check = this.rulesCheck;
    if (check) await this.attempt(() => this.recordRuleRecovery(check.at, check.critical));
    for (const fault of this.faults) {
      const { evidence } = fault;
      if (evidence.kind !== 'rule_violation') await this.attempt(() => this.recordPnlFault(fault, evidence));
    }
    const ruleCopies = this.faults.filter((fault) => fault.evidence.kind === 'rule_violation');
    const first = ruleCopies[0]?.evidence;
    if (first?.kind === 'rule_violation') {
      // Every union's copy carries the same platform-wide findings.
      const critical = distinctViolations(first.violations);
      for (const violation of critical) {
        await this.attempt(() => this.recordRuleFault(ruleCopies, violation, critical));
      }
    }
    await this.attempt(() => this.checkOwnerInbox());
  }

  private async attempt(step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.failures.push(message);
      console.warn('[auto-settlement] Production Alerts write failed:', message);
    }
  }

  private async record(event: {
    eventKey: string;
    alertname: string;
    status: 'firing' | 'resolved';
    severity: 'critical' | 'warning' | 'info';
    payload: Record<string, unknown>;
  }): Promise<void> {
    const receipt = await recordOperationalAlert({
      source: SETTLEMENT_ALERT_SOURCE,
      ...event,
      payload: { ...event.payload, target_task_id: OPERATIONAL_ALERT_TARGET_TASK_ID },
    });
    this.outcomes.push({
      alertname: event.alertname,
      status: event.status,
      union_id: event.payload.union_id ?? null,
      event_key: event.eventKey,
      receipt,
    });
  }

  /** Every store row of one condition's chain: its links and their recoveries. */
  private chain(base: string): Promise<StoreRow[]> {
    return readPages<StoreRow>('incident chain', (after) => {
      let query = this.supabase
        .from('operational_alert_events')
        .select(STORE_COLUMNS)
        .eq('source', SETTLEMENT_ALERT_SOURCE)
        .like('event_key', `${base}%`);
      if (after !== null) query = query.gt('id', after as number);
      return query.order('id', { ascending: true }).limit(PAGE_ROWS);
    });
  }

  /**
   * The open incidents of these alertnames: firing, not finished by the fleet,
   * and with no recovery recorded. Only open rows are read, so incidents that
   * ended never count against anything.
   */
  private async openIncidents(alertnames: string[]): Promise<StoreRow[]> {
    const firing = await readPages<StoreRow>('open incidents', (after) => {
      let query = this.supabase
        .from('operational_alert_events')
        .select(STORE_COLUMNS)
        .eq('source', SETTLEMENT_ALERT_SOURCE)
        .in('alertname', alertnames)
        .eq('status', 'firing')
        .not('investigation_status', 'in', `(${NOT_OPEN.join(',')})`);
      if (after !== null) query = query.gt('id', after as number);
      return query.order('id', { ascending: true }).limit(PAGE_ROWS);
    });
    const recovered = new Set<string>();
    for (const chunk of chunks(firing)) {
      const { data, error } = await this.supabase
        .from('operational_alert_events')
        .select('event_key')
        .eq('source', SETTLEMENT_ALERT_SOURCE)
        .eq('status', 'resolved')
        .in('event_key', chunk.map((row) => resolutionKey(row.event_key)));
      if (error) throw new OperationalAlertDeliveryError(`cannot read recoveries: ${error.message}`);
      if (!Array.isArray(data)) throw new OperationalAlertDeliveryError('recoveries: the read returned no rows array');
      for (const row of data as Array<{ event_key: string }>) recovered.add(row.event_key);
    }
    return firing.filter((row) => !recovered.has(resolutionKey(row.event_key)));
  }

  private faultPayload(fault: FaultIntent, summary: string): Record<string, unknown> {
    const problem = SETTLEMENT_PROBLEMS[fault.evidence.kind];
    return {
      summary,
      kind: fault.evidence.kind,
      title: problem.title,
      union_id: fault.unionId,
      union_name: fault.unionName,
      settlement_week: this.week,
      occurred_at: iso(fault.occurredAt),
      job: JOB,
      delivered_as: fault.recipientsUnknown ? 'recipients_unknown' : 'owner_account_copy',
      other_recipients_notified: fault.otherRecipientsNotified,
    };
  }

  /**
   * One incident per union and kind (pnlIncidentBaseKey): every fault of that
   * union's weekly player P&L of that kind joins the open incident while one is
   * open, whatever window it concerns, and whether or not its window could be
   * read. A failure that lasts three weeks is one incident, and so is a failure
   * whose window turned out to be the next one.
   */
  private async recordPnlFault(fault: FaultIntent, evidence: PnlEvidence): Promise<void> {
    const problem = SETTLEMENT_PROBLEMS[evidence.kind];
    const window = await this.pnlWindowEvidence(fault, evidence);
    const base = pnlIncidentBaseKey(evidence.kind, fault.unionId);
    const { kind: _kind, ...detail } = evidence;
    await this.record({
      eventKey: chooseFaultKey(base, await this.chain(base)),
      alertname: problem.alertname,
      status: 'firing',
      severity: problem.severity,
      payload: {
        ...this.faultPayload(fault, `${problem.title}: union ${fault.unionName ?? fault.unionId}`),
        run_started_at: iso(this.runStartedAt),
        ...window,
        ...detail,
        recovers_when: 'settled union_pnl_settlements rows cover, with no gap, every window this incident holds: '
          + 'from the earliest start its first window can have had through the end of its last one',
      },
    });
  }

  /**
   * One incident per broken invariant, platform-wide, open until a complete
   * check no longer reports it. Every union's owner copy of this run joins it.
   */
  private async recordRuleFault(copies: FaultIntent[], violation: Violation, critical: Violation[]): Promise<void> {
    const problem = SETTLEMENT_PROBLEMS.rule_violation;
    const base = faultBaseKey('rule_violation', PLATFORM_SCOPE, ['invariant', violation.invariant]);
    await this.record({
      eventKey: chooseFaultKey(base, await this.chain(base)),
      alertname: problem.alertname,
      status: 'firing',
      severity: problem.severity,
      payload: {
        summary: `${problem.title}: ${violation.invariant} (platform-wide)`,
        kind: 'rule_violation',
        title: problem.title,
        scope: PLATFORM_SCOPE,
        settlement_week: this.week,
        occurred_at: iso(Math.min(...copies.map((copy) => copy.occurredAt))),
        job: JOB,
        invariant: violation.invariant,
        violations: [violation],
        critical_invariants: critical.map((v) => v.invariant),
        owner_copies: copies.map((copy) => ({
          union_id: copy.unionId,
          union_name: copy.unionName,
          delivered_as: copy.recipientsUnknown ? 'recipients_unknown' : 'owner_account_copy',
          other_recipients_notified: copy.otherRecipientsNotified,
        })),
      },
    });
  }

  /**
   * Every union_pnl_settlements row of a union, any status, read-only and paged
   * to the end, once per flush (after the run's last money call).
   */
  private async unionSettlements(unionId: string): Promise<SettlementRow[]> {
    const cached = this.settlementRows.get(unionId);
    if (cached) return cached;
    const rows = await readPages<SettlementRow>('union settlements', (after) => {
      let query = this.supabase
        .from('union_pnl_settlements')
        .select('id,status,period_start,period_end,settled_at')
        .eq('union_id', unionId);
      if (after !== null) query = query.gt('id', after as string);
      return query.order('id', { ascending: true }).limit(PAGE_ROWS);
    });
    this.settlementRows.set(unionId, rows);
    return rows;
  }

  /**
   * Where the failed or parked call's window started, as far as the union's
   * rows tell (pnlWindowStart): evidence for the fleet, never the incident's
   * identity. A failed read still records the fault, with the error.
   */
  private async pnlWindowEvidence(fault: FaultIntent, evidence: PnlEvidence): Promise<Record<string, unknown>> {
    try {
      const rows = await this.unionSettlements(fault.unionId);
      const parkedId = evidence.kind === 'pnl_needs_review' ? evidence.settlement_id : null;
      const window = pnlWindowStart(rows, this.runStartedAt, fault.occurredAt, parkedId);
      return {
        window_start: window.startText,
        window_basis: window.basis,
        window_anchor_id: window.anchorId,
        window_moved_by: window.movedBy,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        window_start: null,
        window_basis: 'anchor_unreadable',
        window_anchor_id: null,
        window_moved_by: [],
        window_error: clip(message.replace(/^Operational alert was not recorded: /, '')),
      };
    }
  }

  /** A recovery takes its fault's route: same source and alertname, key `<fault key>:resolved`. */
  private async resolve(fault: StoreRow, extra: Record<string, unknown>, summary: string): Promise<void> {
    await this.record({
      eventKey: resolutionKey(fault.event_key),
      alertname: fault.alertname,
      status: 'resolved',
      severity: 'info',
      payload: {
        summary,
        kind: fault.payload?.kind ?? null,
        union_id: fault.payload?.union_id ?? null,
        union_name: fault.payload?.union_name ?? null,
        settlement_week: fault.payload?.settlement_week ?? null,
        resolves: fault.event_key,
        fault_occurred_at: iso(occurredAt(fault)),
        ...extra,
      },
    });
  }

  /**
   * Every open player P&L incident is checked, read-only, against its union's
   * union_pnl_settlements rows: settled rows from this job or any other path
   * (World Hub settle-period.js, a parked period re-run by hand) must cover,
   * with no gap, every window the incident holds (pnlRecoveryRequirement). A
   * settlement that starts later than a window (after a baseline reset, or from
   * a later club period start) leaves that window unsettled, and the proof of
   * one window alone never closes an incident that holds another.
   */
  private async recordPnlRecoveries(): Promise<void> {
    const alertnames = [SETTLEMENT_PROBLEMS.pnl_needs_review.alertname, SETTLEMENT_PROBLEMS.pnl_failed.alertname];
    for (const fault of await this.openIncidents(alertnames)) {
      const unionId = fault.payload?.union_id;
      if (typeof unionId !== 'string') continue;
      const rows = await this.unionSettlements(unionId);
      const need = pnlRecoveryRequirement(fault, rows);
      const cover = settledCoverage(rows, need.startMs, need.endMs);
      if (!cover.covered) continue;
      await this.resolve(fault, {
        window_start: need.startText,
        window_basis: need.startBasis,
        covered_through: iso(need.endMs),
        end_basis: need.endBasis,
        occurrences: need.occurrences,
        last_occurrence_at: iso(need.lastOccurrenceMs),
        covered_by: cover.coveredBy,
        settlement_id: cover.coveredBy[cover.coveredBy.length - 1] ?? null,
        proof: 'settled union_pnl_settlements rows cover every window this incident holds, with no gap',
      }, `Weekly player P&L settled: union ${String(fault.payload?.union_name ?? unionId)} `
        + `(${cover.coveredBy.length} settlement(s) cover all ${need.occurrences} occurrence(s))`);
    }
  }

  private async recordRuleRecovery(checkedAt: number, critical: ReadonlySet<string>): Promise<void> {
    const open = await this.openIncidents([SETTLEMENT_PROBLEMS.rule_violation.alertname]);
    for (const fault of ruleFaultsCleared(open, critical, checkedAt)) {
      const invariant = typeof fault.payload?.invariant === 'string' ? fault.payload.invariant : null;
      await this.resolve(fault, { checked_at: iso(checkedAt), invariant }, invariant
        ? `Union rule ${invariant} is no longer critically violated: both governance checks ran to completion`
        : 'Union governance and settlement conservation checks ran and found no critical violation');
    }
  }

  /** The pushes made of these notices (their mirror rows), by notice id. */
  private async pushesMadeOf(noticeIds: string[]): Promise<Map<string, OutboxPush[]>> {
    const byNotice = new Map<string, OutboxPush[]>();
    for (const chunk of chunks(noticeIds)) {
      const rows = await readPages<OutboxPush>('pushes made of leaked notices', (after) => {
        let query = this.supabase
          .from('push_outbox')
          .select('id,status,related_entity_id')
          .eq('recipient_user_id', OWNER_ACCOUNT_ID)
          .in('related_entity_id', chunk);
        if (after !== null) query = query.gt('id', after as string);
        return query.order('id', { ascending: true }).limit(PAGE_ROWS);
      });
      for (const push of rows) {
        const noticeId = String(push.related_entity_id);
        byNotice.set(noticeId, [...(byNotice.get(noticeId) ?? []), push]);
      }
    }
    return byNotice;
  }

  /** The current status of each of these pushes; a push that no longer exists is absent. */
  private async pushStatuses(pushIds: string[]): Promise<Map<string, unknown>> {
    const statuses = new Map<string, unknown>();
    for (const chunk of chunks(pushIds)) {
      const { data, error } = await this.supabase.from('push_outbox').select('id,status').in('id', chunk);
      if (error) throw new OperationalAlertDeliveryError(`cannot read push statuses: ${error.message}`);
      if (!Array.isArray(data)) throw new OperationalAlertDeliveryError('push statuses: the read returned no rows array');
      for (const row of data as Array<{ id: unknown; status: unknown }>) statuses.set(String(row.id), row.status);
    }
    return statuses;
  }

  /**
   * The notices, of these, whose original operational_notification_destinations
   * holds for the fleet: the owner-destination capture preserved it (at insert,
   * or through the history intake) and took it out of the personal inbox. Its
   * inbox_event_id is the store receipt of that capture, null while pending.
   */
  private async preservedNotices(noticeIds: string[]): Promise<Map<string, Record<string, unknown>>> {
    const preserved = new Map<string, Record<string, unknown>>();
    for (const chunk of chunks(noticeIds)) {
      const { data, error } = await this.supabase
        .from('operational_notification_destinations')
        .select('notification_id,inbox_event_id,captured_at')
        .in('notification_id', chunk)
        .eq('recipient_user_id', OWNER_ACCOUNT_ID)
        .eq('target_task_id', OPERATIONAL_ALERT_TARGET_TASK_ID);
      if (error) throw new OperationalAlertDeliveryError(`cannot read preserved originals: ${error.message}`);
      if (!Array.isArray(data)) throw new OperationalAlertDeliveryError('preserved originals: the read returned no rows array');
      for (const row of data as Array<Record<string, unknown>>) preserved.set(String(row.notification_id), row);
    }
    return preserved;
  }

  /**
   * Detection. Every run reads, with no lookback window and to the end of each
   * read, the owner account's personal inbox (personal_notifications, which
   * leaves out a row the owner-destination capture moved to Production Alerts)
   * for settlement problem notices, and push_outbox for settlement problem
   * pushes queued for its phone, from this sender or any other.
   *
   * Each notice is its own incident, however old. It recovers only when the
   * notice has left the personal inbox AND operational_notification_destinations
   * preserves its original for the fleet AND the capture's receipt is recorded
   * in the store (inbox_event_id): until then the fleet does not have the notice
   * as an event. The owner account can delete or edit its own notifications, so
   * a notice that is simply gone proves nothing: its incident stays open, and
   * the run says so in its outcomes, as it does for a pending receipt. Each
   * queued push is its own incident; it recovers only if the push ends
   * undelivered (skipped or failed). A push that was sent reached the phone:
   * that incident stays open until the fleet closes it, because the harm
   * finishing is not a recovery.
   */
  private async checkOwnerInbox(): Promise<void> {
    const checkedAt = Date.now();
    const noticeRows = await readPages<InboxNotice>('the owner account personal inbox', (after) => {
      let query = this.supabase
        .from('personal_notifications')
        .select('id,type,title,data,created_at')
        .eq('user_id', OWNER_ACCOUNT_ID)
        .eq('type', SETTLEMENT_PROBLEM_CLASSIFIER.type)
        .or(PROBLEM_NOTICE_FILTER);
      if (after !== null) query = query.gt('id', after as string);
      return query.order('id', { ascending: true }).limit(PAGE_ROWS);
    });
    const pushRows = await readPages<OutboxPush>('pushes queued for the owner account phone', (after) => {
      let query = this.supabase
        .from('push_outbox')
        .select('id,event,title,status,related_entity_id,created_at')
        .eq('recipient_user_id', OWNER_ACCOUNT_ID)
        .eq('event', SETTLEMENT_PROBLEM_CLASSIFIER.type)
        .in('status', QUEUED_PUSH_STATUSES)
        .or(PROBLEM_PUSH_FILTER);
      if (after !== null) query = query.gt('id', after as string);
      return query.order('id', { ascending: true }).limit(PAGE_ROWS);
    });
    const present = presentLeaks(noticeRows, pushRows);
    const open = await this.openIncidents([OWNER_INBOX_LEAK.alertname, OWNER_PHONE_LEAK.alertname]);
    const openByBase = new Map(open.map((row) => [baseOf(row.event_key), row]));
    const presentBases = new Set<string>();

    // The pushes made of a notice are evidence, read once, when its incident opens.
    const opening = present.notes.map((note) => String(note.id))
      .filter((id) => !openByBase.has(leakBaseKey('notification', id)));
    const madeOf = await this.pushesMadeOf(opening);
    for (const note of present.notes) {
      const id = String(note.id);
      const base = leakBaseKey('notification', id);
      presentBases.add(base);
      const kind = settlementProblemKind(note);
      await this.record({
        eventKey: openByBase.get(base)?.event_key ?? chooseFaultKey(base, await this.chain(base)),
        alertname: OWNER_INBOX_LEAK.alertname,
        status: 'firing',
        severity: OWNER_INBOX_LEAK.severity,
        payload: {
          summary: `A settlement problem notice (${kind}) remains in the owner account personal inbox`,
          leak: 'notification',
          notification_id: id,
          notice_kind: kind,
          matched_by: problemKindOfMarker(note.data) ? 'marker' : 'title',
          notice_created_at: note.created_at ?? null,
          pushes: (madeOf.get(id) ?? []).map((push) => ({ id: String(push.id), status: push.status ?? null })),
          occurred_at: iso(checkedAt),
          job: JOB,
          recovers_when: 'the notice has left the personal inbox and operational_notification_destinations '
            + 'preserves its original for the fleet, with its store receipt recorded; a notice deleted or edited '
            + 'with no preserved original stays open until the fleet closes it',
        },
      });
    }
    for (const push of present.pushes) {
      const id = String(push.id);
      const base = leakBaseKey('push', id);
      presentBases.add(base);
      const kind = settlementProblemKind({ type: push.event, title: push.title });
      await this.record({
        eventKey: openByBase.get(base)?.event_key ?? chooseFaultKey(base, await this.chain(base)),
        alertname: OWNER_PHONE_LEAK.alertname,
        status: 'firing',
        severity: OWNER_PHONE_LEAK.severity,
        payload: {
          summary: `A settlement problem push (${kind}) is queued for the owner account phone`,
          leak: 'push',
          push_outbox_id: id,
          push_status: push.status ?? null,
          notice_kind: kind,
          related_notification_id: push.related_entity_id == null ? null : String(push.related_entity_id),
          push_created_at: push.created_at ?? null,
          occurred_at: iso(checkedAt),
          job: JOB,
        },
      });
    }

    const gone = open.filter((row) => !presentBases.has(baseOf(row.event_key)));
    const noticeIncidents = gone.filter((r) => r.payload?.leak === 'notification');
    const preserved = await this.preservedNotices(noticeIncidents.map((row) => String(row.payload?.notification_id)));
    for (const row of noticeIncidents) {
      const destination = preserved.get(String(row.payload?.notification_id));
      if (!destination) {
        // Deleted or edited by the owner account, with no preserved original:
        // the harm happened and nothing holds the notice for the fleet.
        this.outcomes.push({
          alertname: row.alertname,
          status: 'left_open',
          event_key: row.event_key,
          reason: 'the notice left the personal inbox, but operational_notification_destinations holds no original '
            + 'for the fleet (deleted or edited by the owner account); only the fleet can close this',
        });
        continue;
      }
      if (destination.inbox_event_id === null || destination.inbox_event_id === undefined) {
        // Preserved, but recording the capture's receipt in the store failed
        // (the destination keeps last_error, and the history intake retries
        // it): the fleet does not have the notice as an event yet.
        this.outcomes.push({
          alertname: row.alertname,
          status: 'left_open',
          event_key: row.event_key,
          reason: 'the notice left the personal inbox and operational_notification_destinations preserves its '
            + 'original, but its store receipt is still pending (inbox_event_id null); this closes once it is recorded',
        });
        continue;
      }
      await this.resolve(row, {
        leak: 'notification',
        notification_id: row.payload?.notification_id ?? null,
        preserved_in: 'operational_notification_destinations',
        destination_captured_at: destination.captured_at ?? null,
        inbox_event_id: destination.inbox_event_id ?? null,
        checked_at: iso(checkedAt),
      }, 'The settlement problem notice left the owner account personal inbox, and its original is preserved '
        + 'for the fleet in operational_notification_destinations');
    }
    const pushIncidents = gone.filter((r) => r.payload?.leak === 'push');
    const statuses = await this.pushStatuses(pushIncidents.map((row) => String(row.payload?.push_outbox_id)));
    for (const row of pushIncidents) {
      const status = statuses.get(String(row.payload?.push_outbox_id));
      // Sent: the push reached the phone, and the incident stays open for the
      // fleet. Gone, or queued again: nothing proves it never reached it.
      if (pushOutcome(status) !== 'undelivered') {
        this.outcomes.push({
          alertname: row.alertname,
          status: 'left_open',
          event_key: row.event_key,
          reason: status === 'sent'
            ? 'the push was sent: it reached the phone; only the fleet can close this'
            : 'the push row is gone or queued again: nothing proves it never reached the phone',
        });
        continue;
      }
      await this.resolve(row, {
        leak: 'push',
        push_outbox_id: row.payload?.push_outbox_id ?? null,
        push_status: status,
        checked_at: iso(checkedAt),
      }, `The settlement problem push ended ${String(status)} and never reached the owner account phone`);
    }
  }
}
