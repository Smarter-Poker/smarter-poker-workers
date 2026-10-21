import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoSettlement } from './auto-settlement.js';
import {
  ANCHOR, FAILED, FLEET, LEAK, LEGACY_SHAPED_LEAKS, MONDAY_1, MONDAY_2, MONDAY_3, MONDAY_4, MONDAY_5,
  ONE_CLUB, OTHER_UNION, OTHER_UNION_OWNER, OWNER, PARKED, PLAYER_IN_DETAIL, RULE, SOURCE, UNION,
  UNION_ADMIN, critical, failed, needsReview, pad, skipped, timedOut, ownerRoutingHelpers, type Row,
  type RpcResult, type Leak,
} from './auto-settlement.owner-routing.harness.js';

// Regression, production-alerts lane: the owner account's copy of the weekly
// settlement's problem notices goes to Production Alerts. This file covers the
// P&L, rule-violation, notice-write and store paths;
// auto-settlement.owner-inbox.test.ts covers the notices already in the owner
// account's personal inbox or queued for its phone. Both build their fake from
// auto-settlement.owner-routing.harness.ts, whose literal, synthetic ids let
// them run against the pre-fix route too.
const db = await vi.hoisted(async () => {
  const { createOwnerRoutingDb } = await import('./auto-settlement.owner-routing.harness.js');
  return createOwnerRoutingDb('fn_record_operational_alert');
});

vi.mock('../lib/supabase.js', () => ({ getSupabase: () => db.client }));

const ctx = () => ({ json: (body: unknown, status = 200) => ({ body, status }) });
const run = async () => (await autoSettlement(ctx() as never)) as unknown as { status: number; body: any };
const at = (iso: string) => vi.setSystemTime(new Date(iso));
const { ownerNotices, ownerPushes, events, seedLeak, preserve } = ownerRoutingHelpers(db);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(MONDAY_1);
  Object.assign(db.state, {
    clubs: ONE_CLUB,
    unions: [{ id: UNION, name: 'Test Union', owner_id: OWNER }],
    unionAdmins: [{ union_id: UNION, user_id: OWNER }, { union_id: UNION, user_id: UNION_ADMIN }],
    notifications: [], pushOutbox: [], store: [], governance: [], pnlRows: [], destinations: [],
    conservation: { data: [], error: null }, storeDown: false, dbClockAheadMs: 0, insertThrows: false, failRead: null,
    rpcCalls: [], queries: [], pnl: skipped,
  });
});
afterEach(() => { vi.useRealTimers(); });

describe('weekly settlement problem notices: the owner account copy goes to Production Alerts', () => {
  it('records a parked P&L for the owner account in the store, addressed to the fleet, and never in its inbox', async () => {
    db.state.pnl = needsReview;
    const response = await run();

    expect(response.status).toBe(200);
    expect(ownerNotices()).toEqual([]);
    expect(ownerPushes()).toEqual([]);
    const [event, ...more] = events(PARKED);
    expect(more).toEqual([]);
    expect(event).toMatchObject({ status: 'firing', severity: 'warning', payload: {
      target_task_id: FLEET, kind: 'pnl_needs_review', union_id: UNION, union_name: 'Test Union',
      settlement_week: '2027-09-27', reason: 'does_not_reconcile', settlement_id: 'settlement-review-1',
    } });
    expect(JSON.stringify(event.payload)).not.toContain(OWNER);
    expect(JSON.stringify(event.payload)).not.toContain(UNION_ADMIN);
  });

  // The union's own contacts get the notice they always got. Its data also
  // carries the settlement problem marker the database classifier matches.
  it('keeps the other union admin notification as before, with the problem marker in its data', async () => {
    db.state.pnl = needsReview;
    await run();

    const adminRows = db.state.notifications.filter((n) => n.user_id === UNION_ADMIN);
    expect(adminRows).toHaveLength(1);
    expect(adminRows[0]).toMatchObject({
      user_id: UNION_ADMIN, type: 'settlement', title: 'Weekly player P&L needs review', read: false,
      message: "This week's club/union player win-loss settlement was NOT paid. Reason: does_not_reconcile. "
        + 'Club win/loss did not net out across the union. No chips were moved. '
        + 'Review it on the union dashboard, then it can be re-run for this period.',
    });
    expect(adminRows[0].data).toEqual({ union_id: UNION, union_name: 'Test Union', reason: 'does_not_reconcile',
      settlement_id: 'settlement-review-1', needs_review: true,
      component: SOURCE, alertname: PARKED, severity: 'warning' });
  });

  it('records a failed P&L with its real error, and a critical rule break without player detail', async () => {
    db.state.pnl = failed;
    db.state.governance = critical;
    await run();

    expect(ownerNotices()).toEqual([]);
    expect(ownerPushes()).toEqual([]);
    expect(events(FAILED)).toHaveLength(1);
    expect(events(FAILED)[0]).toMatchObject({ status: 'firing', severity: 'critical', payload: {
      target_task_id: FLEET, kind: 'pnl_failed', union_id: UNION,
      error: { message: 'pnl_union_wallet_missing', code: 'P0001' },
    } });
    const [rule] = events(RULE);
    expect(rule).toMatchObject({ status: 'firing', severity: 'critical', payload: {
      target_task_id: FLEET, kind: 'rule_violation', scope: 'platform', invariant: 'negative_balance',
      violations: [{ invariant: 'negative_balance', severity: 'critical', offenders: 1 }],
      owner_copies: [{ union_id: UNION, union_name: 'Test Union', delivered_as: 'owner_account_copy',
        other_recipients_notified: 1 }],
    } });
    expect(JSON.stringify(rule.payload)).not.toContain(PLAYER_IN_DETAIL);
    expect(db.state.notifications.map((n) => [n.user_id, n.title, n.data.alertname])).toEqual([
      [UNION_ADMIN, 'Weekly player P&L failed', FAILED],
      [UNION_ADMIN, 'Union rule violation detected', RULE],
    ]);
  });

  it('coalesces a re-run in the same settlement week into one incident', async () => {
    db.state.pnl = failed;
    await run();
    at('2027-09-27T10:05:00.000Z');
    await run();

    const rows = events(FAILED);
    expect(rows).toHaveLength(1);
    expect(rows[0].delivery_count).toBe(2);
    expect(ownerNotices()).toEqual([]);
  });

  it('records the recovery once a settlement covers the failed window from its anchor, and a later fault is new', async () => {
    db.state.pnlRows = [{ ...ANCHOR }];
    db.state.pnl = failed;
    await run();
    const [fault] = events(FAILED, 'firing');
    // The failed call was settling from the union's chain anchor.
    expect(fault.payload).toMatchObject({ window_start: ANCHOR.period_end, window_basis: 'chain_anchor',
      window_anchor_id: ANCHOR.id });

    at(MONDAY_2);
    db.state.pnl = db.settleFromChain;
    await run();
    const settlement = db.state.pnlRows[db.state.pnlRows.length - 1] as Row;
    expect(settlement).toMatchObject({ status: 'settled', period_start: ANCHOR.period_end, period_end: MONDAY_2 });
    expect(events(FAILED, 'firing')).toHaveLength(1);
    const [recovery] = events(FAILED, 'resolved');
    expect(recovery).toMatchObject({ event_key: `${fault.event_key}:resolved`, severity: 'info', payload: {
      target_task_id: FLEET, resolves: fault.event_key, union_id: UNION, settlement_id: settlement.id,
      covered_by: [settlement.id], window_start: ANCHOR.period_end, window_basis: 'chain_anchor', occurrences: 1,
    } });

    at(MONDAY_3);
    db.state.pnl = failed;
    await run();
    const firing = events(FAILED, 'firing');
    expect(firing).toHaveLength(2);
    expect(firing[1].event_key).not.toBe(fault.event_key);
    expect(firing[1].payload).toMatchObject({ settlement_week: '2027-10-11', window_start: MONDAY_2,
      window_anchor_id: settlement.id });
  });

  // Reviewer B, round 3: a failure lasting three weeks left three open
  // incidents for the same unsettled window, because the week was in the key.
  it('keeps one incident per kind for an unsettled window, however many weeks fail it, and one recovery names each', async () => {
    db.state.pnlRows = [{ ...ANCHOR }];
    db.state.pnl = failed;
    await run();
    at(MONDAY_2);
    await run();
    at(MONDAY_3);
    await run();

    const [fault, ...more] = events(FAILED, 'firing');
    expect(more).toEqual([]);
    expect(fault).toMatchObject({ delivery_count: 3, payload: { settlement_week: '2027-09-27',
      window_start: ANCHOR.period_end, window_anchor_id: ANCHOR.id } });

    // The same window parked for review is the same window, reported as its own kind.
    at(MONDAY_4);
    db.state.pnl = needsReview;
    await run();
    const [parked] = events(PARKED, 'firing');
    expect(parked.payload).toMatchObject({ window_start: ANCHOR.period_end });

    at(MONDAY_5);
    db.state.pnl = db.settleFromChain;
    await run();
    expect(events(FAILED)).toHaveLength(2);
    expect(events(FAILED, 'resolved')).toMatchObject([{ event_key: `${fault.event_key}:resolved`,
      payload: { resolves: fault.event_key, window_start: ANCHOR.period_end, occurrences: 3 } }]);
    expect(events(PARKED, 'resolved')).toMatchObject([{ payload: { resolves: parked.event_key } }]);
  });

  // Reviewer reproduction: with no settled or baseline row the live function
  // settles now() - 7 days. The fault is stamped 10:00:20; the next call runs
  // at 10:00:05, so its window starts 15 seconds after the failed week began
  // and that week is never settled. It must not count as a recovery.
  it('never recovers a failure from a settlement that did not cover its window (no chain anchor)', async () => {
    at('2027-09-27T10:00:20.000Z');
    db.state.pnl = failed;
    await run();
    const [fault] = events(FAILED, 'firing');

    at('2027-10-04T10:00:05.000Z');
    db.state.pnl = db.settleFromChain;
    await run();
    expect(db.state.pnlRows).toMatchObject([{ status: 'settled', period_start: '2027-09-27T10:00:05.000Z',
      period_end: '2027-10-04T10:00:05.000Z' }]);
    expect(events(FAILED, 'resolved')).toEqual([]);
    // The call's own fallback: no later than 7 days before the run, less the margin.
    expect(fault.payload).toMatchObject({ window_start: '2027-09-20T09:50:20.000Z', window_basis: 'no_anchor',
      window_anchor_id: null });

    // Later settlements chain from that one and can never reach back either.
    at('2027-10-11T10:00:05.000Z');
    await run();
    expect(events(FAILED, 'resolved')).toEqual([]);
  });

  it('never records a recovery for a result that did not settle the books', async () => {
    db.state.pnl = failed;
    await run();
    for (const [monday, result] of [
      [MONDAY_2, { data: { success: false, error: 'pnl_no_club_basis' }, error: null }],
      [MONDAY_3, skipped()],
    ] as Array<[string, RpcResult]>) {
      at(monday);
      db.state.pnl = () => result;
      await run();
    }
    expect(events(FAILED, 'resolved')).toEqual([]);
  });

  // The clubs phase and the failing call take 20 seconds. Meanwhile a baseline
  // reset for the union commits after the call read its anchor, so the failed
  // window [ANCHOR, 10:00:20] is skipped, not settled. The reset's period_end
  // is earlier than the fault, but later than the run's start.
  it('does not take an anchor written during the run for the failed call\'s own', async () => {
    db.state.pnlRows = [{ ...ANCHOR }];
    db.state.pnl = () => {
      db.state.pnlRows.push({ id: 'pnl-baseline-during-run', union_id: UNION, status: 'baseline',
        period_start: '2027-09-27T10:00:09.000Z', period_end: '2027-09-27T10:00:10.000Z', settled_at: '2027-09-27T10:00:09.000Z' });
      at('2027-09-27T10:00:20.000Z');
      return failed();
    };
    await run();
    at(MONDAY_2);
    db.state.pnl = db.settleFromChain;
    await run();

    expect(db.state.pnlRows[db.state.pnlRows.length - 1]).toMatchObject({ status: 'settled',
      period_start: '2027-09-27T10:00:10.000Z' });
    expect(events(FAILED, 'resolved')).toEqual([]);
    // The call read the anchor before the reset, or the reset: the earlier start is the one to prove.
    expect(events(FAILED, 'firing')[0].payload).toMatchObject({ occurred_at: '2027-09-27T10:00:20.000Z',
      window_start: ANCHOR.period_end, window_basis: 'anchor_moved', window_anchor_id: ANCHOR.id,
      window_moved_by: ['pnl-baseline-during-run'] });
  });

  // Reviewer A, round 3: with the database clock 2 s behind the worker, a
  // baseline reset committed 1 s into the run carries a period_end 1 s BEFORE
  // the run started, and was taken for the failed call's own anchor. The next
  // week's settlement from that reset then "recovered" a window it skipped.
  it('does not take an anchor for the failed call\'s own when the database clock runs behind the worker', async () => {
    db.state.pnlRows = [{ ...ANCHOR }];
    db.state.pnl = () => {
      at('2027-09-27T10:00:01.000Z');
      const databaseNow = Date.now() - 2000;
      db.state.pnlRows.push({ id: 'pnl-baseline-skewed', union_id: UNION, status: 'baseline',
        period_start: new Date(databaseNow - 1000).toISOString(), period_end: new Date(databaseNow).toISOString(),
        settled_at: new Date(databaseNow - 1000).toISOString() });
      return failed();
    };
    await run();
    expect(events(FAILED, 'firing')[0].payload).toMatchObject({ window_start: ANCHOR.period_end,
      window_basis: 'anchor_moved', window_anchor_id: ANCHOR.id, window_moved_by: ['pnl-baseline-skewed'] });

    at(MONDAY_2);
    db.state.pnl = db.settleFromChain;
    await run();
    // The chain re-settled from the reset, so the failed window was skipped.
    expect(db.state.pnlRows[db.state.pnlRows.length - 1]).toMatchObject({ status: 'settled',
      period_start: '2027-09-27T09:59:59.000Z' });
    expect(events(FAILED, 'resolved')).toEqual([]);
  });

  it('leaves a fault open when a baseline reset moved the chain past it (skipped, not settled)', async () => {
    db.state.pnlRows = [{ ...ANCHOR }];
    db.state.pnl = failed;
    await run();
    // The union is re-anchored on Wednesday, after the failure.
    db.state.pnlRows.push({ id: 'pnl-baseline-2', union_id: UNION, status: 'baseline',
      period_start: '2027-09-29T12:00:00.000Z', period_end: '2027-09-29T12:00:01.000Z', settled_at: '2027-09-29T12:00:00.000Z' });
    at(MONDAY_2);
    db.state.pnl = db.settleFromChain;
    await run();
    expect(db.state.pnlRows[db.state.pnlRows.length - 1]).toMatchObject({ status: 'settled',
      period_start: '2027-09-29T12:00:01.000Z' });
    expect(events(FAILED, 'resolved')).toEqual([]);
    expect(events(FAILED, 'firing')[0].payload).toMatchObject({ window_start: ANCHOR.period_end });
  });

  // Review round 5: one transient error reading the chain anchor
  // opened a week-named incident beside the open incident of the same window.
  // The window settled; the week-named one could never close.
  it('joins the open incident when the chain anchor cannot be read, so one settlement closes the window', async () => {
    db.state.pnlRows = [{ ...ANCHOR }];
    db.state.pnl = failed;
    await run();
    const [fault] = events(FAILED, 'firing');

    at(MONDAY_2);
    db.state.failRead = (q) => q.table === 'union_pnl_settlements';
    await run();
    expect(events(FAILED)).toMatchObject([{ event_key: fault.event_key, delivery_count: 2 }]);

    at(MONDAY_3);
    db.state.failRead = null;
    db.state.pnl = db.settleFromChain;
    await run();
    expect(events(FAILED, 'resolved')).toMatchObject([{ payload: { resolves: fault.event_key } }]);
    expect(events(FAILED, 'firing')).toHaveLength(1);
  });

  it('still records a fault whose anchor cannot be read when no incident of that kind is open', async () => {
    db.state.failRead = (q) => q.table === 'union_pnl_settlements';
    db.state.pnl = failed;
    await run();
    const [fault, ...more] = events(FAILED, 'firing');
    expect(more).toEqual([]);
    expect(fault.payload).toMatchObject({ window_basis: 'anchor_unreadable', window_start: null });
    expect(fault.payload.window_error).toContain('canceling statement due to statement timeout');
  });

  // Reviewer B, round 5: the parked notice tells the union to re-run the
  // period, and World Hub settle-period.js does, by hand. This job never saw
  // that settlement, so the incident could never close.
  it('recovers when a settlement made outside this job covers the window, and not from one that starts later', async () => {
    db.state.pnlRows = [{ ...ANCHOR }];
    db.state.pnl = needsReview;
    await run();
    const [parked] = events(PARKED, 'firing');

    // A later manual settlement from the club's own period start does not reach back.
    db.state.pnlRows.push({ id: 'manual-late', union_id: UNION, status: 'settled',
      period_start: '2027-09-27T12:00:00.000Z', period_end: '2027-09-27T13:00:00.000Z', settled_at: '2027-09-27T13:00:00.000Z' });
    at('2027-09-27T18:00:00.000Z');
    db.state.pnl = skipped;
    await run();
    expect(events(PARKED, 'resolved')).toEqual([]);

    // The parked period re-run by hand from the anchor: proof, though this job settled nothing.
    db.state.pnlRows.push({ id: 'manual-rerun', union_id: UNION, status: 'settled',
      period_start: ANCHOR.period_end, period_end: '2027-09-28T15:00:00.000Z', settled_at: '2027-09-28T15:00:00.000Z' });
    at('2027-09-28T16:00:00.000Z');
    await run();
    expect(events(PARKED, 'resolved')).toMatchObject([{ event_key: `${parked.event_key}:resolved`, payload: {
      resolves: parked.event_key, settlement_id: 'manual-rerun', covered_by: ['manual-rerun'],
      window_start: ANCHOR.period_end } }]);
  });

  // Review round 6 (A): the anchor read failed in week 1 and opened a
  // week-named incident; week 2 read the anchor and opened a second one for
  // the same window; the week-3 settlement closed only the second.
  it('keeps one incident when one week cannot read the anchor and the next can, and closes it once the window settles', async () => {
    db.state.pnlRows = [{ ...ANCHOR }];
    db.state.pnl = failed;
    db.state.failRead = (q) => q.table === 'union_pnl_settlements';
    await run();
    at(MONDAY_2);
    db.state.failRead = null;
    await run();
    const [incident, ...more] = events(FAILED, 'firing');
    expect(more).toEqual([]);
    expect(incident).toMatchObject({ delivery_count: 2, payload: { window_basis: 'anchor_unreadable' } });

    at(MONDAY_3);
    db.state.pnl = db.settleFromChain;
    await run();
    expect(events(FAILED, 'resolved')).toMatchObject([{ payload: { resolves: incident.event_key, occurrences: 2,
      window_start: ANCHOR.period_end } }]);
    expect(events(FAILED, 'firing')).toHaveLength(1);
  });

  it('keeps one incident for a parked window whose anchor could not be read, and closes it on a manual re-settlement', async () => {
    db.state.pnlRows = [{ ...ANCHOR }];
    db.state.pnl = needsReview;
    db.state.failRead = (q) => q.table === 'union_pnl_settlements';
    await run();
    at(MONDAY_2);
    db.state.failRead = null;
    await run();
    const [incident, ...more] = events(PARKED, 'firing');
    expect(more).toEqual([]);

    // The period re-run by hand from the anchor, after both weeks.
    db.state.pnlRows.push({ id: 'manual-rerun', union_id: UNION, status: 'settled',
      period_start: ANCHOR.period_end, period_end: '2027-10-05T15:00:00.000Z', settled_at: '2027-10-05T15:00:00.000Z' });
    at('2027-10-05T16:00:00.000Z');
    db.state.pnl = skipped;
    await run();
    expect(events(PARKED, 'resolved')).toMatchObject([{ payload: { resolves: incident.event_key,
      covered_by: ['manual-rerun'], occurrences: 2 } }]);
  });

  // Review round 6 (B): a baseline written 5 minutes before the run is a chain
  // row the failed call may or may not have read, and the next week reads it
  // as the anchor. Same union and kind: one incident. The call settled from
  // that baseline or from the anchor before it; nothing recorded tells which,
  // and the baseline skipped the span between, so no settlement from the
  // baseline can prove the first window: the fleet closes it.
  it('keeps one incident when a baseline was written within the margin before the run, and leaves the span it skipped to the fleet', async () => {
    db.state.pnlRows = [{ ...ANCHOR }, { id: 'baseline-5min', union_id: UNION, status: 'baseline',
      period_start: '2027-09-27T09:54:59.000Z', period_end: '2027-09-27T09:55:00.000Z', settled_at: '2027-09-27T09:54:59.000Z' }];
    db.state.pnl = failed;
    await run();
    at(MONDAY_2);
    await run();
    at(MONDAY_3);
    db.state.pnl = db.settleFromChain;
    await run();

    const [incident, ...more] = events(FAILED, 'firing');
    expect(more).toEqual([]);
    expect(incident).toMatchObject({ delivery_count: 2, payload: { window_basis: 'anchor_moved',
      window_start: ANCHOR.period_end, window_moved_by: ['baseline-5min'] } });
    expect(db.state.pnlRows[db.state.pnlRows.length - 1]).toMatchObject({ status: 'settled',
      period_start: '2027-09-27T09:55:00.000Z' });
    expect(events(FAILED, 'resolved')).toEqual([]);
  });

  it('closes that incident when the row written within the margin is a settlement, which settled the span between', async () => {
    db.state.pnlRows = [{ ...ANCHOR }, { id: 'manual-5min', union_id: UNION, status: 'settled',
      period_start: ANCHOR.period_end, period_end: '2027-09-27T09:55:00.000Z', settled_at: '2027-09-27T09:55:00.000Z' }];
    db.state.pnl = failed;
    await run();
    at(MONDAY_2);
    await run();
    at(MONDAY_3);
    db.state.pnl = db.settleFromChain;
    await run();

    const [incident, ...more] = events(FAILED, 'firing');
    expect(more).toEqual([]);
    const settlement = db.state.pnlRows[db.state.pnlRows.length - 1] as Row;
    expect(events(FAILED, 'resolved')).toMatchObject([{ payload: { resolves: incident.event_key,
      window_start: ANCHOR.period_end, covered_by: ['manual-5min', settlement.id] } }]);
  });

  it('knows a parked call\'s window from its parked row even then, and closes it once that window settles', async () => {
    db.state.pnlRows = [{ ...ANCHOR }, { id: 'baseline-5min', union_id: UNION, status: 'baseline',
      period_start: '2027-09-27T09:54:59.000Z', period_end: '2027-09-27T09:55:00.000Z', settled_at: '2027-09-27T09:54:59.000Z' }];
    db.state.pnl = db.parkFromChain;
    await run();
    at(MONDAY_2);
    await run();
    at(MONDAY_3);
    db.state.pnl = db.settleFromChain;
    await run();

    const [incident, ...more] = events(PARKED, 'firing');
    expect(more).toEqual([]);
    expect(incident.payload).toMatchObject({ window_basis: 'parked_row', window_start: '2027-09-27T09:55:00.000Z' });
    expect(events(PARKED, 'resolved')).toMatchObject([{ payload: { resolves: incident.event_key,
      window_basis: 'parked_row', occurrences: 2 } }]);
  });

  // Review round 6 (A): a manual settlement covered the incident's window W1;
  // the next week the recovery read and the anchor read both failed, and the
  // new failure (window W2) joined the incident; the week after, the call
  // returned before_settlement_floor. W1's proof closed the incident and left
  // W2 unsettled with none open.
  it('never closes an incident on the proof of its first window while a later window it holds is unsettled', async () => {
    db.state.pnlRows = [{ ...ANCHOR }];
    db.state.pnl = failed;
    await run();
    const [incident] = events(FAILED, 'firing');
    db.state.pnlRows.push({ id: 'manual-w1', union_id: UNION, status: 'settled',
      period_start: ANCHOR.period_end, period_end: '2027-09-30T12:00:00.000Z', settled_at: '2027-09-30T12:00:00.000Z' });

    at(MONDAY_2);
    db.state.failRead = (q) => q.table === 'union_pnl_settlements';
    await run();
    expect(events(FAILED)).toMatchObject([{ event_key: incident.event_key, delivery_count: 2 }]);

    at(MONDAY_3);
    db.state.failRead = null;
    db.state.pnl = () => ({ data: { success: false, error: 'before_settlement_floor' }, error: null });
    await run();
    expect(events(FAILED, 'resolved')).toEqual([]);
    expect(events(FAILED, 'firing')).toMatchObject([{ event_key: incident.event_key }]);

    // W2, from the manual settlement, settles at last: every window is proved.
    at(MONDAY_4);
    db.state.pnl = db.settleFromChain;
    await run();
    const settlement = db.state.pnlRows[db.state.pnlRows.length - 1] as Row;
    expect(events(FAILED, 'resolved')).toMatchObject([{ payload: { resolves: incident.event_key, occurrences: 2,
      covered_by: ['manual-w1', settlement.id] } }]);
  });

  // Review round 7 (A): the anchor read failed when the call failed, so the
  // recovery took the window's start from the rows as they are now. A
  // settlement made by hand two days later, for a past span inside the failed
  // window, became that anchor; the next week's settlement chained from it,
  // and the span from the real anchor to that span's start, which nothing
  // settled, was taken for proved.
  it('never takes a row written after the fault for the anchor its window started from', async () => {
    db.state.pnlRows = [{ ...ANCHOR }];
    db.state.pnl = failed;
    db.state.failRead = (q) => q.table === 'union_pnl_settlements';
    await run();
    const [incident] = events(FAILED, 'firing');
    expect(incident.payload).toMatchObject({ window_basis: 'anchor_unreadable', window_start: null });

    // Written by hand on Wednesday, for a past span inside the failed window.
    db.state.pnlRows.push({ id: 'late-partial', union_id: UNION, status: 'settled',
      period_start: '2027-09-15T00:00:00.000Z', period_end: '2027-09-19T00:00:00.000Z', settled_at: '2027-09-29T12:00:00.000Z' });
    at(MONDAY_2);
    db.state.failRead = null;
    db.state.pnl = db.settleFromChain;
    await run();
    const weekly = db.state.pnlRows[db.state.pnlRows.length - 1] as Row;
    // The chain settled on from that row: the span before it was never settled.
    expect(weekly).toMatchObject({ status: 'settled', period_start: '2027-09-19T00:00:00.000Z', period_end: MONDAY_2 });
    expect(events(FAILED, 'resolved')).toEqual([]);

    // Once that span is settled too, every window is proved.
    db.state.pnlRows.push({ id: 'manual-gap', union_id: UNION, status: 'settled', period_start: ANCHOR.period_end,
      period_end: '2027-09-15T00:00:00.000Z', settled_at: '2027-10-05T15:00:00.000Z' });
    at('2027-10-05T16:00:00.000Z');
    db.state.pnl = skipped;
    await run();
    expect(events(FAILED, 'resolved')).toMatchObject([{ payload: { resolves: incident.event_key,
      window_start: ANCHOR.period_end, covered_by: ['manual-gap', 'late-partial', weekly.id] } }]);
  });

  // Review round 7 (A, B): the proof had to reach 10 minutes past the fault by
  // the worker's clock. A re-run 5 minutes later that settled the failed
  // window left the incident open until the next week's settlement, and for
  // good when the chain then skipped a span (the next call parked, and the
  // club period settled by hand from its own start). The store stamps each
  // record with the database clock that stamps the settlement rows.
  it('closes a failure at a re-run minutes later, whose settlement began after the fault was recorded', async () => {
    db.state.pnlRows = [{ ...ANCHOR }];
    db.state.pnl = failed;
    await run();
    const [incident] = events(FAILED, 'firing');

    at('2027-09-27T10:05:00.000Z');
    db.state.pnl = db.settleFromChain;
    await run();
    const rerun = db.state.pnlRows[db.state.pnlRows.length - 1] as Row;
    expect(rerun).toMatchObject({ status: 'settled', period_start: ANCHOR.period_end, period_end: '2027-09-27T10:05:00.000Z' });
    expect(events(FAILED, 'resolved')).toMatchObject([{ payload: { resolves: incident.event_key,
      covered_by: [rerun.id], covered_through: incident.received_at, end_basis: 'last_record' } }]);
  });

  // Its twin, which the worker's clock cannot tell apart: a settlement stamped
  // 10:05 by a database clock 6 minutes ahead of the worker, written just
  // before a call that then timed out. The call may have read it, so the span
  // it left unsettled may begin where that settlement ended; the next call
  // parked from there, and the club period was settled by hand from its own
  // start. That span was never settled, so the incident stays open.
  it('keeps a failure open when the settlement past its fault ended before the fault was recorded', async () => {
    db.state.dbClockAheadMs = 6 * 60 * 1000;
    db.state.pnlRows = [{ ...ANCHOR }, { id: 'settled-before-call', union_id: UNION, status: 'settled',
      period_start: ANCHOR.period_end, period_end: '2027-09-27T10:05:00.000Z', settled_at: '2027-09-27T10:05:00.000Z' }];
    db.state.pnl = timedOut;
    await run();
    const [incident] = events(FAILED, 'firing');
    expect(incident).toMatchObject({ received_at: '2027-09-27T10:06:00.000Z', payload: { occurred_at: MONDAY_1,
      window_basis: 'anchor_moved', window_start: ANCHOR.period_end, window_moved_by: ['settled-before-call'] } });

    at(MONDAY_2);
    db.state.pnl = db.parkFromChain;
    await run();
    db.state.pnlRows.push({ id: 'club-period', union_id: UNION, status: 'settled', period_start: '2027-09-30T00:00:00.000Z',
      period_end: '2027-10-04T12:00:00.000Z', settled_at: '2027-10-04T12:00:00.000Z' });
    at(MONDAY_3);
    db.state.pnl = db.settleFromChain;
    await run();
    expect(db.state.pnlRows[db.state.pnlRows.length - 1]).toMatchObject({ status: 'settled',
      period_start: '2027-10-04T12:00:00.000Z' });
    expect(events(FAILED, 'resolved')).toEqual([]);
    expect(events(PARKED, 'resolved')).toEqual([]);
  });

  it('opens a new incident when a fault recurs after the fleet closed it', async () => {
    db.state.pnl = failed;
    await run();
    expect(events(FAILED)).toHaveLength(1);
    const [first] = events(FAILED);
    first.investigation_status = 'verified_fixed';
    at('2027-09-27T18:00:00.000Z');
    await run();

    const rows = events(FAILED);
    expect(rows).toHaveLength(2);
    expect(rows[0].delivery_count).toBe(1);
    expect(rows[1].event_key).not.toBe(first.event_key);
  });

  it('records a rule-violation recovery only after both checks ran clean', async () => {
    db.state.governance = critical;
    await run();
    at(MONDAY_2);
    db.state.governance = [];
    db.state.conservation = { data: [], error: { message: 'conservation check timed out' } };
    await run();
    expect(events(RULE, 'resolved')).toEqual([]);
    at(MONDAY_3);
    db.state.conservation = { data: [], error: null };
    await run();
    expect(events(RULE, 'resolved')).toHaveLength(1);
  });

  // One incident per broken invariant: the same break on later weeks is the
  // same incident, and it recovers when a complete check no longer reports it,
  // even while another invariant is broken.
  it('keeps one incident per broken invariant until a complete check no longer reports it', async () => {
    // The conservation check reports the same issue once per offender.
    db.state.conservation = { data: [
      { issue: 'negative_balance', severity: 'critical', detail: `wallet ${PLAYER_IN_DETAIL}: -5` },
      { issue: 'negative_balance', severity: 'critical', detail: 'another wallet: -2' },
    ], error: null };
    await run();
    const [negative, ...more] = events(RULE, 'firing');
    expect(more).toEqual([]);
    expect(negative.payload).toMatchObject({ invariant: 'negative_balance',
      violations: [{ invariant: 'negative_balance', offenders: 2 }] });
    expect(JSON.stringify(negative.payload)).not.toContain(PLAYER_IN_DETAIL);

    at(MONDAY_2);
    await run();
    expect(events(RULE)).toMatchObject([{ event_key: negative.event_key, delivery_count: 2 }]);

    at(MONDAY_3);
    db.state.conservation = { data: [], error: null };
    db.state.governance = [{ invariant: 'money_fn_exposed_to_anon', severity: 'critical', offenders: 2, detail: 'd' }];
    await run();
    expect(events(RULE, 'resolved')).toMatchObject([{ event_key: `${negative.event_key}:resolved`,
      payload: { resolves: negative.event_key, invariant: 'negative_balance' } }]);
    expect(events(RULE, 'firing').map((e) => [e.payload.invariant, e.delivery_count])).toEqual([
      ['negative_balance', 2], ['money_fn_exposed_to_anon', 1]]);
  });

  // Review round 5: the governance checks are platform-wide, but
  // each union's owner copy opened its own incident, and a failed unions read
  // opened another under 'unknown'.
  it('keeps one incident per broken invariant for the platform, however many unions report it', async () => {
    db.state.unions = [{ id: UNION, name: 'Test Union', owner_id: OWNER },
      { id: OTHER_UNION, name: 'Other Union', owner_id: OWNER }];
    db.state.governance = critical;
    await run();
    const [rule, ...more] = events(RULE);
    expect(more).toEqual([]);
    expect(rule.payload.owner_copies.map((copy: Row) => copy.union_id)).toEqual([UNION, OTHER_UNION]);

    // The unions read fails: the copy has no union, and it is still the same incident.
    at('2027-09-27T18:00:00.000Z');
    db.state.failRead = (q) => q.table === 'unions';
    await run();
    expect(events(RULE)).toMatchObject([{ event_key: rule.event_key, delivery_count: 2 }]);
  });

  // Review round 6 (B): while no club has auto-settlement enabled the
  // governance checks do not run, so a repaired rule cannot be proved on that
  // path. Documented: the incident waits for the next run that completes both
  // checks, or for the fleet.
  it('leaves a rule incident open through runs with no club on auto-settlement, and recovers it on the next complete check', async () => {
    db.state.governance = critical;
    await run();
    const [rule] = events(RULE, 'firing');
    db.state.governance = [];
    db.state.clubs = [];
    for (const monday of [MONDAY_2, MONDAY_3]) {
      at(monday);
      db.state.rpcCalls = [];
      await run();
      expect(db.state.rpcCalls.filter((name) => name !== 'fn_record_operational_alert')).toEqual([]);
    }
    expect(events(RULE, 'resolved')).toEqual([]);

    at(MONDAY_4);
    db.state.clubs = ONE_CLUB;
    await run();
    expect(events(RULE, 'resolved')).toMatchObject([{ payload: { resolves: rule.event_key } }]);
  });

  it('does not touch a union the owner account is not part of', async () => {
    db.state.unions = [{ id: OTHER_UNION, name: 'Other Union', owner_id: OTHER_UNION_OWNER }];
    db.state.unionAdmins = [];
    db.state.pnl = needsReview;
    await run();

    expect(db.state.notifications.map((n) => [n.user_id, n.title])).toEqual([
      [OTHER_UNION_OWNER, 'Weekly player P&L needs review'],
    ]);
    expect(db.state.store.filter((e) => e.status === 'firing')).toEqual([]);
  });

  it('never falls back to the owner inbox when the store is unavailable, and fails the run', async () => {
    db.state.pnl = failed;
    db.state.storeDown = true;
    const response = await run();

    // 500, not 503: this estate treats 503 as retryable, and the money phases
    // already ran. The dispatcher and the run log are told not to re-run it.
    expect(response.status).toBe(500);
    expect(response.body.retryable).toBe(false);
    expect(ownerNotices()).toEqual([]);
    expect(ownerPushes()).toEqual([]);
    expect(response.body.results.errors.some((e: Row) => e.phase === 'operational_alerts')).toBe(true);
    expect(db.state.notifications.map((n) => n.user_id)).toEqual([UNION_ADMIN]);
  });

  // Review round 8 (A): with the owner split regressed, the guard refused the
  // whole batch and the refusal was swallowed: no notice for the union admin,
  // no store copy, HTTP 200, only a console warning. The split is stood in
  // here, as the regression; the route's own is splitOwnerCopy.
  it('fails the run on a refused owner-addressed batch, keeps the owner copy and still notifies the others', async () => {
    const route = (await import('./auto-settlement.js')) as Record<string, any>;
    const { SettlementAlerts } = (await import('../lib/unionSettlementAlerts.js')) as Record<string, any>;
    const regressed = (recipients: Iterable<string | null | undefined>) => ({
      personal: [...recipients].filter((id): id is string => typeof id === 'string' && id.length > 0),
      ownerCopy: false,
    });
    const alerts = new SettlementAlerts(db.client, Date.now());
    await route.notifyUnionSettlementProblem(db.client, alerts, UNION, 'Test Union',
      { kind: 'pnl_failed', error: { message: 'pnl_union_wallet_missing', code: 'P0001' } },
      'Weekly player P&L failed', 'did not run', { failed: true }, regressed);

    // Nothing reached the owner account, the union admin got its notice, and the refusal is a failure of the run.
    expect(ownerNotices()).toEqual([]);
    expect(db.state.notifications.map((n) => [n.user_id, n.data.alertname])).toEqual([[UNION_ADMIN, FAILED]]);
    expect(alerts.failures).toHaveLength(1);
    expect(alerts.failures[0]).toContain('refused before any write');
    await alerts.flush();
    expect(events(FAILED, 'firing')).toMatchObject([{ payload: { union_id: UNION, delivered_as: 'owner_account_copy',
      other_recipients_notified: 1 } }]);
  });

  it('fails the run when writing a problem notice throws, and still records the owner copy', async () => {
    db.state.pnl = failed;
    db.state.insertThrows = true;
    const response = await run();

    expect(response.status).toBe(500);
    expect(response.body.retryable).toBe(false);
    const failures = response.body.results.errors.filter((e: Row) => e.phase === 'operational_alerts');
    expect(failures).toHaveLength(1);
    expect(String(failures[0].error)).toContain('socket hang up');
    expect(events(FAILED, 'firing')).toMatchObject([{ payload: { union_id: UNION, other_recipients_notified: 0 } }]);
    expect(ownerNotices()).toEqual([]);
  });

  // Reviewer A, round 3: every read counted finished rows and gave up at
  // 1,000, so once this source had 1,000 rows every run would fail forever.
  it('decides with any number of finished incidents in the store', async () => {
    const finished = [FAILED, RULE, LEAK].flatMap((alertname) => Array.from({ length: 1200 }, (_, i) => ({
      id: db.state.seq++, source: SOURCE, event_key: `finished-${alertname}-${pad(i)}`, alertname,
      status: i % 2 === 0 ? 'firing' : 'resolved', severity: 'critical',
      investigation_status: i % 4 === 0 ? 'verified_fixed' : 'historical',
      payload: { union_id: UNION, occurred_at: '2027-05-31T10:00:00.000Z' },
      received_at: '2027-05-31T10:00:00.000Z', last_received_at: '2027-05-31T10:00:00.000Z', delivery_count: 1,
    })));
    db.state.store.push(...finished);
    db.state.pnlRows = [{ ...ANCHOR }];
    db.state.pnl = failed;
    db.state.governance = critical;
    seedLeak({ ...LEGACY_SHAPED_LEAKS[1] as Leak });
    const first = await run();
    expect(first.status).toBe(200);
    expect([FAILED, RULE, LEAK].map((a) => events(a, 'firing').filter((e) => e.investigation_status === 'new').length))
      .toEqual([1, 1, 1]);

    at(MONDAY_2);
    db.state.pnl = db.settleFromChain;
    db.state.governance = [];
    preserve('leak-note-2');
    const second = await run();
    expect(second.status).toBe(200);
    expect([FAILED, RULE, LEAK].map((a) => events(a, 'resolved').filter((e) => e.investigation_status === 'new').length))
      .toEqual([1, 1, 1]);
  });
});
