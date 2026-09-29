// Shared fixtures of the auto-settlement owner-routing tests:
// auto-settlement.owner-routing.test.ts and auto-settlement.owner-inbox.test.ts.
// Not a test file (vitest collects only *.test.ts). It imports nothing, so a
// test file can build its fake inside vi.hoisted, before supabase.js is mocked.
//
// Regression, production-alerts lane: the weekly settlement's problem notices
// ("Weekly player P&L needs review", "Weekly player P&L failed", "Union rule
// violation detected") were written to public.notifications for the owner
// account, and the push mirror sent them to its phone. That copy belongs in
// public.operational_alert_events, addressed to the fleet. Literal ids on
// purpose: the tests must also run against the pre-fix route, where the
// routing modules do not exist, and fail there on their assertions. Every id
// and time below is synthetic.
export const OWNER = '47965354-0e56-43ef-931c-ddaab82af765';
export const FLEET = '01a09b86-5ba8-7290-8657-1041f13dd3ca';
export const UNION = 'aaaaaaaa-0000-4000-8000-000000000001';
export const OTHER_UNION = 'aaaaaaaa-0000-4000-8000-000000000002';
export const UNION_ADMIN = 'bbbbbbbb-0000-4000-8000-000000000001';
export const OTHER_UNION_OWNER = 'bbbbbbbb-0000-4000-8000-000000000002';
export const PLAYER_IN_DETAIL = 'cccccccc-0000-4000-8000-000000000001';
export const SOURCE = 'workers.auto-settlement';
export const PROBLEM_TITLES = [
  'Weekly player P&L needs review',
  'Weekly player P&L failed',
  'Union rule violation detected',
];
export const LEAK = 'OwnerSettlementNoticeReachedPersonalInbox';
export const PHONE = 'OwnerSettlementPushQueuedForPhone';
export const FAILED = 'UnionPlayerPnlFailed';
export const PARKED = 'UnionPlayerPnlNeedsReview';
export const RULE = 'UnionRuleViolation';

export type Row = Record<string, any>;
export type RpcResult = { data: unknown; error: unknown };

/**
 * The fake Supabase a test file runs the route against. `recordRpc` is the name
 * of the store writer's RPC. Each test file passes it in: the source check in
 * lib/operationalAlerts.test.ts lets no file outside the tests name it but
 * lib/operationalAlerts.ts.
 */
export function createOwnerRoutingDb(recordRpc: string) {
  const OWNER_ID = '47965354-0e56-43ef-931c-ddaab82af765';
  const FLEET_ID = '01a09b86-5ba8-7290-8657-1041f13dd3ca';
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  type Query = { table: string; op: string; rows?: Row[]; filters: Array<[string, string, unknown]>; orders: Array<[string, boolean]>; limit?: number };
  const state = {
    clubs: [] as Row[],
    unions: [] as Row[],
    unionAdmins: [] as Row[],
    notifications: [] as Row[],
    pushOutbox: [] as Row[],
    store: [] as Row[],
    // public.union_pnl_settlements: the weekly P&L chain.
    pnlRows: [] as Row[],
    // public.operational_notification_destinations: originals the owner-destination
    // capture preserved for the fleet (no foreign key: deleting the notification keeps it).
    destinations: [] as Row[],
    pnl: (() => ({ data: null, error: null })) as (unionId: string) => RpcResult,
    governance: [] as Row[],
    conservation: { data: [] as Row[], error: null as unknown },
    storeDown: false,
    // How far the database clock runs ahead of the worker's (behind when negative).
    dbClockAheadMs: 0,
    // A notifications write that throws instead of answering.
    insertThrows: false,
    // A read the fake fails, as a transient database error.
    failRead: null as null | ((q: Query) => boolean),
    // Every RPC the route called, by name, in order.
    rpcCalls: [] as string[],
    // Every table read or write, as `<op> <table>`, in order.
    queries: [] as string[],
    seq: 1,
  };

  // The database's now(): what it stamps on the rows it writes.
  const now = () => new Date(Date.now() + state.dbClockAheadMs).toISOString();
  const pick = (row: Row, column: string) => {
    const path = column.split('->>');
    if (path.length === 2) {
      const value = row[path[0] as string]?.[path[1] as string];
      return value === undefined || value === null ? null : String(value);
    }
    return row[column];
  };
  const compare = (a: unknown, b: unknown) => {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    const [x, y] = [Date.parse(String(a)), Date.parse(String(b))];
    if (/^\d{4}-/.test(String(a)) && Number.isFinite(x) && Number.isFinite(y)) return x - y;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  };
  // PostgREST LIKE/ILIKE: `*` or `%` match any run of characters, `_` one.
  const pattern = (value: string, flags: string) => new RegExp(`^${value.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[*%]/g, '.*').replace(/_/g, '.')}$`, flags);
  // A PostgREST logic tree of comma-separated `column.operator.value` terms, for
  // the two operators the route uses inside or=(...), compiled once per query.
  const compileOr = (expression: string) => {
    const terms = expression.split(',').map((term) => {
      const parsed = /^(.+?)\.(eq|ilike)\.(.*)$/.exec(term);
      if (!parsed) throw new Error(`fake supabase: unsupported or() term ${term}`);
      const [, column, op, value] = parsed as unknown as [string, string, string, string];
      const regex = op === 'ilike' ? pattern(value, 'is') : null;
      return (row: Row) => {
        const actual = pick(row, column);
        if (!regex) return actual !== null && actual !== undefined && String(actual) === value;
        return typeof actual === 'string' && regex.test(actual);
      };
    });
    return (row: Row) => terms.some((term) => term(row));
  };
  const present = (v: unknown) => v !== null && v !== undefined;
  const matches = (row: Row, filters: Array<[string, string, unknown]>) => filters.every(([op, column, value]) => {
    if (op === 'or') return (value as (row: Row) => boolean)(row);
    const actual = pick(row, column);
    if (op === 'eq') return actual === value;
    if (op === 'in') return (value as unknown[]).includes(actual);
    if (op === 'gte') return present(actual) && compare(actual, value) >= 0;
    if (op === 'gt') return present(actual) && compare(actual, value) > 0;
    if (op === 'lte') return present(actual) && compare(actual, value) <= 0;
    if (op === 'like') return typeof actual === 'string' && (value as RegExp).test(actual);
    if (op === 'not.in') {
      const list = String(value).replace(/^\(|\)$/g, '').split(',');
      return present(actual) && !list.includes(String(actual));
    }
    throw new Error(`fake supabase: unsupported filter ${op}`);
  });

  function tableRows(table: string): Row[] {
    switch (table) {
      case 'clubs': return state.clubs;
      case 'unions': return state.unions;
      case 'union_admins': return state.unionAdmins;
      case 'notifications': return state.notifications;
      // The live view: fn_notification_has_personal_destination leaves out an
      // owner-account row recorded in operational_notification_destinations for the fleet.
      case 'personal_notifications': {
        const preserved = new Set(state.destinations.filter((d) => d.target_task_id === FLEET_ID)
          .map((d) => d.notification_id));
        return state.notifications.filter((n) => n.user_id !== OWNER_ID || !preserved.has(n.id));
      }
      case 'push_outbox': return state.pushOutbox;
      case 'union_pnl_settlements': return state.pnlRows;
      case 'operational_alert_events': return state.store;
      case 'operational_notification_destinations': return state.destinations;
      default: return [];
    }
  }
  function execute(q: Query, single: boolean) {
    state.queries.push(`${q.op} ${q.table}`);
    if (q.op === 'insert' && q.table === 'notifications' && state.insertThrows) throw new Error('socket hang up');
    if (q.op === 'insert') {
      if (q.table === 'notifications') {
        for (const row of q.rows ?? []) {
          const stored = { id: `n-${state.seq++}`, created_at: now(), ...row };
          state.notifications.push(stored);
          // trg_mirror_notification_to_push_outbox: every notification becomes a push.
          state.pushOutbox.push({ id: `p-${state.seq++}`, recipient_user_id: row.user_id, event: row.type,
            title: row.title, status: 'pending', related_entity_id: stored.id, created_at: stored.created_at });
        }
      }
      return { data: null, error: null };
    }
    if (q.op === 'update') return { data: null, error: null };
    if (q.table === 'operational_alert_events' && state.storeDown) {
      return { data: null, error: { message: 'store unavailable' } };
    }
    if (state.failRead?.(q)) return { data: null, error: { message: 'canceling statement due to statement timeout' } };
    let rows = tableRows(q.table).filter((row) => matches(row, q.filters));
    if (q.table === 'settlement_locks' || q.table === 'settlement_periods') rows = [];
    if (q.orders.length > 0) {
      rows = [...rows].sort((a, b) => {
        for (const [column, ascending] of q.orders) {
          const order = compare(a[column], b[column]);
          if (order !== 0) return ascending ? order : -order;
        }
        return 0;
      });
    }
    if (q.limit !== undefined) rows = rows.slice(0, q.limit);
    if (single) return { data: rows[0] ?? null, error: null };
    return { data: rows.map((row) => ({ ...row })), error: null };
  }

  function from(table: string) {
    const q: Query = { table, op: 'select', rows: undefined, filters: [], orders: [], limit: undefined };
    const api: Record<string, unknown> = {
      select: () => api,
      insert: (rows: Row | Row[]) => { q.op = 'insert'; q.rows = Array.isArray(rows) ? rows : [rows]; return api; },
      update: () => { q.op = 'update'; return api; },
      eq: (column: string, value: unknown) => { q.filters.push(['eq', column, value]); return api; },
      in: (column: string, value: unknown[]) => { q.filters.push(['in', column, value]); return api; },
      gte: (column: string, value: unknown) => { q.filters.push(['gte', column, value]); return api; },
      gt: (column: string, value: unknown) => { q.filters.push(['gt', column, value]); return api; },
      lte: (column: string, value: unknown) => { q.filters.push(['lte', column, value]); return api; },
      like: (column: string, value: string) => { q.filters.push(['like', column, pattern(value, 's')]); return api; },
      not: (column: string, operator: string, value: string) => {
        if (operator !== 'in') throw new Error(`fake supabase: unsupported not.${operator}`);
        q.filters.push(['not.in', column, value]);
        return api;
      },
      or: (expression: string) => { q.filters.push(['or', expression, compileOr(expression)]); return api; },
      lt: () => api,
      order: (column: string, options?: { ascending?: boolean }) => {
        q.orders.push([column, options?.ascending !== false]);
        return api;
      },
      limit: (n: number) => { q.limit = n; return api; },
      maybeSingle: async () => execute(q, true),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve().then(() => execute(q, false)).then(resolve, reject),
    };
    return api;
  }

  function recordAlert(args: Row): RpcResult {
    if (state.storeDown) return { data: null, error: { message: 'store unavailable' } };
    const existing = state.store.find((row) => row.source === args.p_source && row.event_key === args.p_event_key);
    if (existing) {
      // The store writer's RPC: ON CONFLICT bumps delivery; payload and status stay.
      existing.last_received_at = now();
      existing.delivery_count += 1;
      return { data: existing.id, error: null };
    }
    const id = state.seq++;
    state.store.push({ id, source: args.p_source, event_key: args.p_event_key, alertname: args.p_alertname,
      status: args.p_status, severity: args.p_severity, payload: args.p_payload, received_at: now(),
      last_received_at: now(), delivery_count: 1, investigation_status: 'new' });
    return { data: id, error: null };
  }

  /**
   * fn_union_settle_player_pnl_weekly as it is live: the window starts at the
   * period_end of the union's latest settled or baseline row (by period_start),
   * or at now() - 7 days when there is none, and ends now(); under 12 hours it
   * is skipped. A settlement records its own row, which anchors the next window,
   * with settled_at now() (fn_union_settle_player_pnl, in the same transaction).
   */
  function settleFromChain(unionId: string): RpcResult {
    const anchor = state.pnlRows
      .filter((r) => r.union_id === unionId && ['settled', 'baseline'].includes(r.status))
      .sort((a, b) => compare(b.period_start, a.period_start))[0];
    const periodEnd = now();
    const periodStart = anchor ? String(anchor.period_end) : new Date(Date.parse(periodEnd) - WEEK_MS).toISOString();
    if (Date.parse(periodEnd) - Date.parse(periodStart) < 12 * 60 * 60 * 1000) {
      return { data: { success: true, skipped: true, reason: 'period_too_short', period_start: periodStart, period_end: periodEnd }, error: null };
    }
    const id = `settlement-${state.seq++}`;
    state.pnlRows.push({ id, union_id: unionId, status: 'settled', period_start: periodStart, period_end: periodEnd,
      settled_at: periodEnd });
    return { data: { success: true, settlement_id: id, union_id: unionId, period_start: periodStart,
      period_end: periodEnd, total_collected: 10, total_paid: 10, total_unpaid: 0 }, error: null };
  }

  /**
   * The same call parked for review: fn_union_settle_player_pnl_guarded
   * records the window it would have settled as a needs_review row.
   */
  function parkFromChain(unionId: string): RpcResult {
    const anchor = state.pnlRows
      .filter((r) => r.union_id === unionId && ['settled', 'baseline'].includes(r.status))
      .sort((a, b) => compare(b.period_start, a.period_start))[0];
    const periodEnd = now();
    const periodStart = anchor ? String(anchor.period_end) : new Date(Date.parse(periodEnd) - WEEK_MS).toISOString();
    const id = `parked-${state.seq++}`;
    state.pnlRows.push({ id, union_id: unionId, status: 'needs_review', period_start: periodStart, period_end: periodEnd,
      settled_at: periodEnd });
    return { data: { success: false, needs_review: true, reason: 'does_not_reconcile', settlement_id: id,
      message: 'Club win/loss did not net out across the union.' }, error: null };
  }

  const client = {
    from,
    rpc: async (name: string, args: Row = {}) => {
      state.rpcCalls.push(name);
      switch (name) {
        case recordRpc: return recordAlert(args);
        case 'fn_union_settle_player_pnl_weekly': return state.pnl(String(args.p_union_id));
        case 'fn_union_governance_check': return { data: state.governance, error: null };
        case 'fn_settlement_conservation_check': return state.conservation;
        default: return { data: null, error: null };
      }
    },
  };
  return { state, client, settleFromChain, parkFromChain };
}
export type OwnerRoutingDb = ReturnType<typeof createOwnerRoutingDb>;

export const MONDAY_1 = '2027-09-27T10:00:00.000Z';
export const MONDAY_2 = '2027-10-04T10:00:00.000Z';
export const MONDAY_3 = '2027-10-11T10:00:00.000Z';
export const MONDAY_4 = '2027-10-18T10:00:00.000Z';
export const MONDAY_5 = '2027-10-25T10:00:00.000Z';
export const pad = (i: number) => String(i).padStart(5, '0');

export const needsReview = (): RpcResult => ({ data: { success: false, needs_review: true, reason: 'does_not_reconcile',
  settlement_id: 'settlement-review-1', message: 'Club win/loss did not net out across the union.' }, error: null });
// PostgREST errors are plain objects, not Error instances.
export const failed = (): RpcResult => ({ data: null, error: { message: 'pnl_union_wallet_missing', code: 'P0001', details: null, hint: null } });
export const timedOut = (): RpcResult => ({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014',
  details: null, hint: null } });
export const skipped = (): RpcResult => ({ data: { success: true, skipped: true, reason: 'period_too_short', hours: 2 }, error: null });
export const critical = [{ invariant: 'negative_balance', severity: 'critical', offenders: 1,
  detail: `player wallet ${PLAYER_IN_DETAIL} holds a negative balance: -5` }];

// The union's chain anchor is a baseline row (timestamps shaped as PostgREST
// returns them, with microseconds). fn_union_pnl_bootstrap writes a baseline at
// its period_start, and a manual settlement below is written at its period_end
// unless the test says otherwise.
export const ANCHOR = { id: 'pnl-baseline-1', union_id: UNION, status: 'baseline',
  period_start: '2027-09-05T03:30:00.125000+00:00', period_end: '2027-09-05T03:30:01.125000+00:00',
  settled_at: '2027-09-05T03:30:00.125000+00:00' };

export type Leak = { id: string; createdAt: string; title: string; data: Row; pushId: string; pushStatus: string };
// Synthetic ids and times, in the shape of the rows production holds: a failed
// P&L, a rule violation and a failed P&L, one push skipped and two sent.
export const LEGACY_SHAPED_LEAKS: Leak[] = [
  { id: 'leak-note-1', createdAt: '2027-07-05T10:02:00.100000+00:00', title: PROBLEM_TITLES[1] as string,
    data: { union_id: UNION, failed: true }, pushId: 'leak-push-1', pushStatus: 'skipped' },
  { id: 'leak-note-2', createdAt: '2027-07-12T10:01:00.200000+00:00', title: PROBLEM_TITLES[2] as string,
    data: { union_id: UNION, governance_check: true }, pushId: 'leak-push-2', pushStatus: 'sent' },
  { id: 'leak-note-3', createdAt: '2027-07-19T10:01:00.300000+00:00', title: PROBLEM_TITLES[1] as string,
    data: { union_id: UNION, failed: true }, pushId: 'leak-push-3', pushStatus: 'sent' },
];
// One enabled club with no open period: the money phases run and settle nothing.
export const ONE_CLUB = [{ id: 'club-1', name: 'Club One', owner_id: null, union_id: null, auto_settlement_enabled: true }];

/** Helpers over one test file's fake. */
export function ownerRoutingHelpers(db: OwnerRoutingDb) {
  const ownerNotices = () => db.state.notifications.filter((n) => n.user_id === OWNER);
  const ownerPushes = () => db.state.pushOutbox.filter((p) => p.recipient_user_id === OWNER);
  const events = (alertname: string, status?: string) => db.state.store
    .filter((e) => e.source === SOURCE && e.alertname === alertname && (!status || e.status === status));
  // A problem notice in the owner account's inbox, and the push the mirror made of it.
  const seedLeak = (leak: Leak) => {
    db.state.notifications.push({ id: leak.id, user_id: OWNER, type: 'settlement', title: leak.title,
      data: leak.data, created_at: leak.createdAt });
    db.state.pushOutbox.push({ id: leak.pushId, recipient_user_id: OWNER, event: 'settlement', title: leak.title,
      status: leak.pushStatus, related_entity_id: leak.id, created_at: leak.createdAt });
  };
  const ownerNotice = (id: string, title: string, data: Row = {}) => db.state.notifications.push({
    id, user_id: OWNER, type: 'settlement', title, data, created_at: '2027-09-20T11:00:00.000000+00:00' });
  const directPush = (id: string, status: string, createdAt = '2027-09-26T09:00:00.000Z') => {
    const push = { id, recipient_user_id: OWNER, event: 'settlement', title: PROBLEM_TITLES[1], status,
      related_entity_id: null, created_at: createdAt };
    db.state.pushOutbox.push(push);
    return push;
  };
  // The owner-destination capture preserves a notice's original for the fleet and
  // takes the row out of the personal inbox; the row itself stays. inbox_event_id
  // is the capture's receipt in the store, null while recording it failed.
  const preserve = (notificationId: string, inboxEventId: number | null = 9000 + db.state.destinations.length) =>
    db.state.destinations.push({ notification_id: notificationId, recipient_user_id: OWNER, target_task_id: FLEET,
      inbox_event_id: inboxEventId, captured_at: new Date().toISOString() });
  // The owner account deletes its own notification (RLS "Users can delete own notifications").
  const ownerDeletes = (notificationId: string) => {
    db.state.notifications = db.state.notifications.filter((n) => n.id !== notificationId);
  };
  return { ownerNotices, ownerPushes, events, seedLeak, ownerNotice, directPush, preserve, ownerDeletes };
}
