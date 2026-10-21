import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoSettlement } from './auto-settlement.js';
import {
  FAILED, FLEET, LEAK, LEGACY_SHAPED_LEAKS, MONDAY_1, MONDAY_2, MONDAY_3, MONDAY_4, ONE_CLUB, OWNER, PHONE,
  PROBLEM_TITLES, SOURCE, UNION, UNION_ADMIN, pad, skipped, ownerRoutingHelpers, type Row,
} from './auto-settlement.owner-routing.harness.js';

// Regression, production-alerts lane: settlement problem notices already in
// the owner account's personal inbox, or queued for its phone. The P&L,
// rule-violation, notice-write and store paths are in
// auto-settlement.owner-routing.test.ts.
// Both build their fake from auto-settlement.owner-routing.harness.ts, whose
// literal, synthetic ids let them run against the pre-fix route too.
const db = await vi.hoisted(async () => {
  const { createOwnerRoutingDb } = await import('./auto-settlement.owner-routing.harness.js');
  return createOwnerRoutingDb('fn_record_operational_alert');
});

vi.mock('../lib/supabase.js', () => ({ getSupabase: () => db.client }));

const ctx = () => ({ json: (body: unknown, status = 200) => ({ body, status }) });
const run = async () => (await autoSettlement(ctx() as never)) as unknown as { status: number; body: any };
const at = (iso: string) => vi.setSystemTime(new Date(iso));
const { events, seedLeak, ownerNotice, directPush, preserve, ownerDeletes } = ownerRoutingHelpers(db);

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

describe('settlement problem notices already in the owner account personal inbox', () => {
  it('records each notice still there as its own incident, however old, and keeps it open while it remains', async () => {
    LEGACY_SHAPED_LEAKS.forEach(seedLeak);
    await run();
    at(MONDAY_2);
    await run();
    at(MONDAY_3);
    await run();

    const leaks = events(LEAK);
    expect(leaks.map((e) => [e.status, e.delivery_count, e.payload.notification_id])).toEqual([
      ['firing', 3, 'leak-note-1'], ['firing', 3, 'leak-note-2'], ['firing', 3, 'leak-note-3']]);
    expect(leaks[1]).toMatchObject({ severity: 'critical', payload: { target_task_id: FLEET, leak: 'notification',
      notice_kind: 'rule_violation', matched_by: 'title', pushes: [{ id: 'leak-push-2', status: 'sent' }] } });
    // Their pushes were already delivered or dropped: history, not a push still queued.
    expect(events(PHONE)).toEqual([]);
    expect(JSON.stringify(leaks)).not.toContain(OWNER);
  });

  // Reviewer reproduction: the second week's run still runs the old code and
  // leaks a notice; the third week's run records it; the fourth week's run had
  // nothing new to report, but the row is still in the owner account's inbox.
  it('does not resolve a leak just because it is more than a week old', async () => {
    seedLeak({ id: 'leak-note-4', createdAt: '2027-10-04T10:00:21.000Z', title: PROBLEM_TITLES[1] as string,
      data: { union_id: UNION, failed: true }, pushId: 'leak-push-4', pushStatus: 'sent' });
    at(MONDAY_3);
    await run();
    at(MONDAY_4);
    await run();

    expect(events(LEAK, 'resolved')).toEqual([]);
    expect(events(LEAK, 'firing')).toMatchObject([{ delivery_count: 2, payload: { notification_id: 'leak-note-4' } }]);
  });

  it('resolves the incident once its notice has left the personal inbox with its original preserved, on the same route', async () => {
    seedLeak({ id: 'leak-note-5', createdAt: '2027-09-24T10:00:00.000Z', title: PROBLEM_TITLES[0] as string,
      data: { union_id: UNION, needs_review: true }, pushId: 'leak-push-5', pushStatus: 'sent' });
    await run();
    const [leak] = events(LEAK, 'firing');

    // The capture records the row in operational_notification_destinations:
    // the original row and its push history stay, outside the personal inbox.
    preserve('leak-note-5');
    at('2027-09-27T18:00:00.000Z');
    await run();

    const [recovery, ...more] = events(LEAK, 'resolved');
    expect(more).toEqual([]);
    expect(recovery).toMatchObject({ event_key: `${leak.event_key}:resolved`, severity: 'info', payload: {
      target_task_id: FLEET, resolves: leak.event_key, notification_id: 'leak-note-5',
      preserved_in: 'operational_notification_destinations', inbox_event_id: 9000,
    } });
  });

  // Review round 8 (B): a leak closed on a destination row whose store receipt
  // was still pending, so the fleet could be left without the notice as an event.
  it('keeps a leak open while its preserved original has no store receipt, and closes it once the receipt is recorded', async () => {
    seedLeak({ id: 'leak-note-11', createdAt: '2027-09-24T10:00:00.000Z', title: PROBLEM_TITLES[1] as string,
      data: { union_id: UNION, failed: true }, pushId: 'leak-push-11', pushStatus: 'sent' });
    await run();
    const [leak] = events(LEAK, 'firing');

    // The capture preserved the original, but recording its receipt failed.
    preserve('leak-note-11', null);
    at('2027-09-27T18:00:00.000Z');
    const response = await run();
    expect(events(LEAK, 'resolved')).toEqual([]);
    const leftOpen = response.body.results.operational_alerts.filter((o: Row) => o.status === 'left_open');
    expect(leftOpen).toMatchObject([{ alertname: LEAK, event_key: leak.event_key }]);
    expect(leftOpen[0].reason).toContain('store receipt is still pending');

    // The capture's next attempt records it.
    (db.state.destinations[0] as Row).inbox_event_id = 9100;
    at(MONDAY_2);
    await run();
    expect(events(LEAK, 'resolved')).toMatchObject([{ payload: { resolves: leak.event_key, inbox_event_id: 9100 } }]);
  });

  // Reviewer A, round 5, probe S1: the owner account may delete its own
  // notifications. A leaked notice deleted with nothing preserved was taken for
  // a recovery: the incident closed because the harm finished, and the original
  // was never kept anywhere.
  it('keeps a leak open when the owner account deletes the notice and nothing preserved its original', async () => {
    seedLeak({ id: 'leak-note-9', createdAt: '2027-09-24T10:00:00.000Z', title: PROBLEM_TITLES[1] as string,
      data: { union_id: UNION, failed: true }, pushId: 'leak-push-9', pushStatus: 'sent' });
    await run();
    const [leak] = events(LEAK, 'firing');

    ownerDeletes('leak-note-9');
    at('2027-09-27T18:00:00.000Z');
    const response = await run();
    at(MONDAY_2);
    await run();

    expect(response.status).toBe(200);
    expect(events(LEAK, 'resolved')).toEqual([]);
    expect(events(LEAK, 'firing')).toMatchObject([{ event_key: leak.event_key, delivery_count: 1 }]);
    // The run says why it left the incident open.
    const leftOpen = response.body.results.operational_alerts.filter((o: Row) => o.status === 'left_open');
    expect(leftOpen).toMatchObject([{ alertname: LEAK, event_key: leak.event_key }]);
    expect(leftOpen[0].reason).toContain('holds no original');
    // And the incident said so from its first record.
    expect(leak.payload.recovers_when).toContain('with no preserved original stays open');
  });

  // Reviewer B, round 3: the incident key was the set of leaked row ids, so a
  // cleanup of one row, or a new leak, opened a second incident while the
  // first stayed firing and stale.
  it('closes exactly the incident of a notice that was cleaned up, and gives a new leak its own incident', async () => {
    LEGACY_SHAPED_LEAKS.forEach(seedLeak);
    await run();
    const [first, second, third] = events(LEAK, 'firing');

    preserve('leak-note-2');
    at(MONDAY_2);
    await run();
    expect(events(LEAK, 'resolved')).toMatchObject([{ event_key: `${second.event_key}:resolved`,
      payload: { resolves: second.event_key, notification_id: 'leak-note-2' } }]);
    expect(events(LEAK, 'firing').map((e) => [e.event_key, e.delivery_count])).toEqual([
      [first.event_key, 2], [second.event_key, 1], [third.event_key, 2]]);

    seedLeak({ id: 'leak-note-7', createdAt: '2027-10-05T08:00:00.000Z', title: PROBLEM_TITLES[0] as string,
      data: { union_id: UNION }, pushId: 'leak-push-7', pushStatus: 'sent' });
    at(MONDAY_3);
    await run();
    const firing = events(LEAK, 'firing');
    expect(firing.map((e) => e.payload.notification_id)).toEqual(['leak-note-1', 'leak-note-2', 'leak-note-3', 'leak-note-7']);
    expect(firing.map((e) => e.delivery_count)).toEqual([3, 1, 3, 1]);
    expect(events(LEAK, 'resolved')).toHaveLength(1);
  });

  // Reviewer B, round 3: a problem push queued with no inbox row opened an
  // incident that "recovered" once the push was delivered.
  it('keeps a phone incident open when its push is delivered, and closes it only if the push ends undelivered', async () => {
    const delivered = directPush('direct-push-1', 'pending');
    const dropped = directPush('direct-push-2', 'processing');
    await run();
    const [sentIncident, droppedIncident, ...more] = events(PHONE, 'firing');
    expect(more).toEqual([]);
    expect([sentIncident.payload, droppedIncident.payload]).toMatchObject([
      { leak: 'push', push_outbox_id: 'direct-push-1', push_status: 'pending', notice_kind: 'pnl_failed' },
      { leak: 'push', push_outbox_id: 'direct-push-2', push_status: 'processing' },
    ]);

    delivered.status = 'sent';
    dropped.status = 'skipped';
    at(MONDAY_2);
    await run();
    at(MONDAY_3);
    await run();
    expect(events(PHONE, 'resolved')).toMatchObject([{ event_key: `${droppedIncident.event_key}:resolved`,
      payload: { resolves: droppedIncident.event_key, push_status: 'skipped' } }]);
    expect(events(PHONE, 'firing').map((e) => [e.event_key, e.delivery_count]))
      .toEqual([[sentIncident.event_key, 1], [droppedIncident.event_key, 1]]);
  });

  // Reviewer B, round 3: the push read had no status filter, so delivered
  // pushes filled its 200-row cap forever and every run failed.
  it('reads only queued pushes, so any amount of delivered history leaves the check decidable', async () => {
    for (let i = 0; i < 250; i += 1) {
      directPush(`history-${pad(i)}`, 'sent', new Date(Date.parse('2027-07-31T00:00:00.000Z') + i * 60_000).toISOString());
    }
    directPush('queued-now', 'pending', '2027-09-27T09:59:00.000Z');
    const response = await run();

    expect(response.status).toBe(200);
    expect(events(PHONE).map((e) => e.payload.push_outbox_id)).toEqual(['queued-now']);
  });

  // Reviewer B, round 3: the client check only trimmed the ends, while the
  // server filter matched any spacing.
  it('counts a problem notice whatever its case or spacing', async () => {
    ownerNotice('spaced-1', ' weekly  Player\tP&L\n FAILED ');
    await run();
    expect(events(LEAK, 'firing')).toMatchObject([{ payload: { notification_id: 'spaced-1', notice_kind: 'pnl_failed' } }]);
  });

  it('counts a notice by its marker whatever its title says, and never a business notice or a look-alike', async () => {
    ownerNotice('marked-1', 'Player P&L settlement did not run', { component: SOURCE, alertname: FAILED, severity: 'critical' });
    ownerNotice('business-1', 'Settlement Complete - Club One Period #7', { club_id: 'club-1', total_rake: 10 });
    ownerNotice('flag-only-1', 'Anything', { needs_review: true });
    ownerNotice('other-sender-1', 'Something else', { component: 'another.sender', alertname: FAILED });
    ownerNotice('quoted-1', `Resolved: ${PROBLEM_TITLES[1]}`);
    await run();
    expect(events(LEAK).map((e) => [e.payload.notification_id, e.payload.matched_by])).toEqual([['marked-1', 'marker']]);
  });

  it('reads the whole personal inbox, however many notices match, and records each', async () => {
    for (let i = 0; i < 250; i += 1) ownerNotice(`leak-bulk-${pad(i)}`, PROBLEM_TITLES[0] as string);
    const response = await run();

    expect(response.status).toBe(200);
    const leaks = events(LEAK);
    expect(leaks).toHaveLength(250);
    expect(new Set(leaks.map((e) => e.payload.notification_id)).size).toBe(250);
  });

  it('resolves a preserved leak once a complete read proves it gone, however many look-alike rows the filter returns', async () => {
    seedLeak({ id: 'leak-note-6', createdAt: '2027-09-24T10:00:00.000Z', title: PROBLEM_TITLES[1] as string,
      data: { union_id: UNION, failed: true }, pushId: 'leak-push-6', pushStatus: 'sent' });
    await run();
    expect(events(LEAK, 'firing')).toHaveLength(1);

    // The leaked row is preserved (and so leaves the personal inbox), and 250
    // other settlement notices that the server-side filter cannot rule out
    // (their titles quote a problem title) fill more than one page.
    preserve('leak-note-6');
    for (let i = 0; i < 250; i += 1) ownerNotice(`quoted-${pad(i)}`, `Resolved: ${PROBLEM_TITLES[1]}`);
    at('2027-09-27T18:00:00.000Z');
    const response = await run();

    expect(response.status).toBe(200);
    expect(events(LEAK, 'resolved')).toHaveLength(1);
    expect(events(LEAK, 'firing')).toHaveLength(1);
  });

  // 10,001 rows through the fake take a few seconds: an explicit timeout, so
  // the CI gate cannot flake on vitest's 5 s default.
  it('fails loudly and resolves nothing when a read matches more rows than it pages through', async () => {
    seedLeak({ id: 'leak-note-8', createdAt: '2027-09-24T10:00:00.000Z', title: PROBLEM_TITLES[1] as string,
      data: { union_id: UNION }, pushId: 'leak-push-8', pushStatus: 'sent' });
    await run();
    preserve('leak-note-8');
    for (let i = 0; i < 10_001; i += 1) ownerNotice(`quoted-${pad(i)}`, `Resolved: ${PROBLEM_TITLES[1]}`);
    at('2027-09-27T18:00:00.000Z');
    const response = await run();

    expect(response.status).toBe(500);
    expect(events(LEAK, 'resolved')).toEqual([]);
    expect(response.body.results.errors.some((e: Row) => e.phase === 'operational_alerts'
      && String(e.error).includes('cannot decide'))).toBe(true);
  }, 60_000);

  // Reviewer B, round 5: with no club on auto-settlement the route returned
  // before the alert phase, so detection and recoveries never ran.
  it('runs the alert phase when no club settles, after nothing but the clubs read', async () => {
    db.state.clubs = [];
    seedLeak({ id: 'leak-note-10', createdAt: '2027-09-24T10:00:00.000Z', title: PROBLEM_TITLES[1] as string,
      data: { union_id: UNION }, pushId: 'leak-push-10', pushStatus: 'sent' });
    const response = await run();

    expect(response.status).toBe(200);
    expect(response.body.message).toContain('No clubs with auto-settlement enabled');
    expect(events(LEAK, 'firing')).toMatchObject([{ payload: { notification_id: 'leak-note-10' } }]);
    // Nothing but the alert writer was called: no lock, no settlement, no check.
    expect(db.state.rpcCalls.filter((name) => name !== 'fn_record_operational_alert')).toEqual([]);
    // The clubs read, then only the alert phase's reads: no write to any table.
    const alertPhaseTables = ['operational_alert_events', 'operational_notification_destinations',
      'personal_notifications', 'push_outbox', 'union_pnl_settlements'];
    expect(db.state.queries[0]).toBe('select clubs');
    expect(db.state.queries.slice(1).filter((q) => !alertPhaseTables.map((t) => `select ${t}`).includes(q)))
      .toEqual([]);
  });
});
