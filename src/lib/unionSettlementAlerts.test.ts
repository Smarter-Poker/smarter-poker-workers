import { describe, expect, it } from 'vitest';
import { OperationalAlertDeliveryError } from './operationalAlerts.js';
import {
  ANCHOR_MARGIN_MS,
  MAX_PAGES,
  PAGE_ROWS,
  PROBLEM_TITLE_PATTERNS,
  SETTLEMENT_PROBLEMS,
  SETTLEMENT_PROBLEM_CLASSIFIER,
  chooseFaultKey,
  distinctViolations,
  errorEvidence,
  faultBaseKey,
  leakBaseKey,
  linkKey,
  normalizeTitle,
  openFaults,
  pnlIncidentBaseKey,
  pnlRecoveryRequirement,
  pnlWindowStart,
  presentLeaks,
  problemKindOfMarker,
  problemKindOfTitle,
  problemNoticeMarker,
  pushOutcome,
  readPages,
  resolutionKey,
  ruleFaultsCleared,
  settledCoverage,
  settlementProblemKind,
  settlementWeek,
  type StoreRow,
} from './unionSettlementAlerts.js';

const UNION = 'aaaaaaaa-0000-4000-8000-000000000001';
const row = (event_key: string, status: string, over: Partial<StoreRow> = {}): StoreRow => ({
  event_key,
  alertname: 'UnionPlayerPnlFailed',
  status,
  investigation_status: 'new',
  received_at: '2027-09-27T10:00:30.000Z',
  last_received_at: '2027-09-27T10:00:30.000Z',
  payload: { occurred_at: '2027-09-27T10:00:20.000Z' },
  ...over,
});

describe('settlement problem identity', () => {
  it('names the settlement week by the UTC Monday that starts it', () => {
    expect(settlementWeek(Date.parse('2027-09-27T10:00:00Z'))).toBe('2027-09-27');
    expect(settlementWeek(Date.parse('2027-10-03T23:59:59Z'))).toBe('2027-09-27');
    expect(settlementWeek(Date.parse('2027-10-04T00:00:00Z'))).toBe('2027-10-04');
  });

  it('is stable for one union, kind and condition, and distinct otherwise', () => {
    const key = faultBaseKey('pnl_failed', UNION, ['window', 'anchor-1']);
    expect(faultBaseKey('pnl_failed', UNION, ['window', 'anchor-1'])).toBe(key);
    expect(faultBaseKey('pnl_needs_review', UNION, ['window', 'anchor-1'])).not.toBe(key);
    expect(faultBaseKey('pnl_failed', UNION, ['window', 'anchor-2'])).not.toBe(key);
    expect(faultBaseKey('pnl_failed', UNION, ['week', 'anchor-1'])).not.toBe(key);
    expect(faultBaseKey('pnl_failed', 'aaaaaaaa-0000-4000-8000-000000000002', ['window', 'anchor-1'])).not.toBe(key);
    expect(leakBaseKey('notification', 'n-1')).not.toBe(leakBaseKey('push', 'n-1'));
    expect(/^[0-9a-f]{64}$/.test(key)).toBe(true);
  });

  it('chains a condition as the base, then <base>:r1, <base>:r2, each recovered at <key>:resolved', () => {
    expect(linkKey('b', 0)).toBe('b');
    expect(linkKey('b', 2)).toBe('b:r2');
    expect(resolutionKey(linkKey('b', 2))).toBe('b:r2:resolved');
  });

  it('coalesces into the open incident, and never into a recovered or closed one', () => {
    const base = faultBaseKey('pnl_failed', UNION, ['week', '2027-09-27']);
    expect(chooseFaultKey(base, [])).toBe(base);
    expect(chooseFaultKey(base, [row(base, 'firing')])).toBe(base);
    expect(chooseFaultKey(base, [row(base, 'firing'), row(resolutionKey(base), 'resolved')])).toBe(`${base}:r1`);
    for (const closed of ['verified_fixed', 'historical', 'test']) {
      expect(chooseFaultKey(base, [row(base, 'firing', { investigation_status: closed })])).toBe(`${base}:r1`);
    }
    for (const open of ['investigating', 'blocked']) {
      expect(chooseFaultKey(base, [row(base, 'firing', { investigation_status: open })])).toBe(base);
    }
    expect(chooseFaultKey(base, [row(base, 'firing'), row(resolutionKey(base), 'resolved'),
      row(`${base}:r1`, 'firing', { investigation_status: 'historical' })])).toBe(`${base}:r2`);
  });

  it('never opens a second incident beside an open link, and never reuses a link that has a recovery', () => {
    const base = faultBaseKey('pnl_failed', UNION, ['week', '2027-09-27']);
    // The base row is gone (deleted), and link 1 is still open.
    expect(chooseFaultKey(base, [row(`${base}:r1`, 'firing')])).toBe(`${base}:r1`);
    // Link 0 has a recovery but no fault row: it is used.
    expect(chooseFaultKey(base, [row(resolutionKey(base), 'resolved')])).toBe(`${base}:r1`);
    // Rows of another chain never count.
    const other = faultBaseKey('pnl_failed', UNION, ['week', '2027-10-04']);
    expect(chooseFaultKey(base, [row(other, 'firing'), row(`${base}x`, 'firing')])).toBe(base);
  });

  it('counts as open only a firing fault that was neither recovered nor finished by the fleet', () => {
    const rows = [row('a', 'firing'), row('b', 'firing'), row(resolutionKey('b'), 'resolved'),
      row('c', 'firing', { investigation_status: 'verified_fixed' }), row('d', 'firing', { investigation_status: 'blocked' })];
    expect(openFaults(rows).map((r) => r.event_key)).toEqual(['a', 'd']);
  });
});

describe('a player P&L incident holds every unsettled window of its union and kind', () => {
  const ANCHOR_END = '2027-09-05T03:30:01.125000+00:00';
  const RUN_START = Date.parse('2027-09-27T10:00:00.000Z');
  const FAULT_AT = Date.parse('2027-09-27T10:00:20.000Z');
  // settled_at as the database writes it: a baseline at its period_start
  // (fn_union_pnl_bootstrap), a weekly settlement or a parked row at its
  // period_end (both are now() of the call).
  const chainRow = (id: string, status: string, period_start: string, period_end: string,
    settled_at: string | null = status === 'baseline' ? period_start : period_end) =>
    ({ id, status, period_start, period_end, settled_at });
  const anchor = chainRow('a-1', 'baseline', '2027-09-05T03:30:00.125000+00:00', ANCHOR_END);

  it('is one incident per union and kind, whatever window or week a fault concerns', () => {
    const key = pnlIncidentBaseKey('pnl_failed', UNION);
    expect(pnlIncidentBaseKey('pnl_failed', UNION)).toBe(key);
    expect(pnlIncidentBaseKey('pnl_needs_review', UNION)).not.toBe(key);
    expect(pnlIncidentBaseKey('pnl_failed', 'aaaaaaaa-0000-4000-8000-000000000002')).not.toBe(key);
    expect(/^[0-9a-f]{64}$/.test(key)).toBe(true);
  });

  it('starts the window at the latest chain row that ended at least the margin before the run', () => {
    const rows = [anchor, chainRow('old', 'settled', '2027-07-31T00:00:00.000Z', '2027-08-07T00:00:00.000Z'),
      chainRow('parked', 'needs_review', ANCHOR_END, '2027-09-26T10:00:00.000Z'),
      chainRow('gone', 'superseded', ANCHOR_END, '2027-09-26T11:00:00.000Z')];
    expect(pnlWindowStart(rows, RUN_START, FAULT_AT)).toEqual({ startMs: Date.parse(ANCHOR_END),
      startText: ANCHOR_END, basis: 'chain_anchor', anchorId: 'a-1', movedBy: [] });
    // Ended exactly the margin before the run: the call could see it.
    const edge = new Date(RUN_START - ANCHOR_MARGIN_MS).toISOString();
    expect(pnlWindowStart([anchor, chainRow('edge', 'settled', ANCHOR_END, edge)], RUN_START, FAULT_AT))
      .toMatchObject({ startText: edge, basis: 'chain_anchor', anchorId: 'edge' });
    expect(ANCHOR_MARGIN_MS).toBe(10 * 60 * 1000);
  });

  it('holds the earlier anchor when a chain row ended within the margin of the run, or during it', () => {
    // A baseline 5 minutes before the run (the call may have read it or not),
    // one 1 ms inside the margin, one written during the run, and a settlement
    // a week later that the call cannot have seen.
    const rows = [anchor,
      chainRow('b-5min', 'baseline', '2027-09-27T09:54:59.000Z', '2027-09-27T09:55:00.000Z'),
      chainRow('b-edge', 'baseline', '2027-09-27T09:49:59.000Z', '2027-09-27T09:50:00.001Z'),
      chainRow('b-run', 'baseline', '2027-09-27T10:00:09.000Z', '2027-09-27T10:00:10.000Z'),
      chainRow('later', 'settled', '2027-09-27T10:00:10.000Z', '2027-10-04T10:00:05.000Z')];
    expect(pnlWindowStart(rows, RUN_START, FAULT_AT)).toEqual({ startMs: Date.parse(ANCHOR_END),
      startText: ANCHOR_END, basis: 'anchor_moved', anchorId: 'a-1', movedBy: ['b-5min', 'b-edge', 'b-run'] });
  });

  it('takes a parked call\'s own window from its parked row, and the chain when that row cannot be found', () => {
    const rows = [anchor, chainRow('b-5min', 'baseline', '2027-09-27T09:54:59.000Z', '2027-09-27T09:55:00.000Z'),
      chainRow('parked-1', 'superseded', '2027-09-27T09:55:00.000Z', '2027-09-27T10:00:19.000Z')];
    expect(pnlWindowStart(rows, RUN_START, FAULT_AT, 'parked-1')).toEqual({ startMs: Date.parse('2027-09-27T09:55:00.000Z'),
      startText: '2027-09-27T09:55:00.000Z', basis: 'parked_row', anchorId: 'parked-1', movedBy: [] });
    expect(pnlWindowStart(rows, RUN_START, FAULT_AT, 'not-there')).toMatchObject({ basis: 'anchor_moved', anchorId: 'a-1' });
  });

  it('falls back to 7 days before the run, less the margin, with no chain row to anchor on', () => {
    const start = RUN_START - ANCHOR_MARGIN_MS - 7 * 24 * 60 * 60 * 1000;
    expect(pnlWindowStart([], RUN_START, FAULT_AT)).toEqual({ startMs: start, startText: new Date(start).toISOString(),
      basis: 'no_anchor', anchorId: null, movedBy: [] });
  });

  it('is proved settled only by settled rows that cover the whole span with no gap', () => {
    const s = (id: string, start: string, end: string, status = 'settled') => chainRow(id, status, start, end);
    const from = Date.parse('2027-09-05T00:00:00.000Z');
    const to = Date.parse('2027-09-19T00:00:00.000Z');
    expect(settledCoverage([s('one', '2027-08-31T00:00:00.000Z', '2027-09-20T00:00:00.000Z')], from, to))
      .toEqual({ covered: true, coveredBy: ['one'] });
    // Adjacent settlements, in any order: this job's, then a manual one.
    expect(settledCoverage([s('b', '2027-09-09T00:00:00.000Z', '2027-09-19T00:00:00.000Z'),
      s('a', '2027-09-05T00:00:00.000Z', '2027-09-09T00:00:00.000Z')], from, to))
      .toEqual({ covered: true, coveredBy: ['a', 'b'] });
    for (const rows of [
      // A gap of one second.
      [s('a', '2027-09-05T00:00:00.000Z', '2027-09-09T00:00:00.000Z'), s('b', '2027-09-09T00:00:01.000Z', '2027-09-19T00:00:00.000Z')],
      // A baseline skipped its span; it settled nothing.
      [s('a', '2027-09-05T00:00:00.000Z', '2027-09-09T00:00:00.000Z'), s('reset', '2027-09-09T00:00:00.000Z', '2027-09-09T00:00:01.000Z', 'baseline'),
        s('b', '2027-09-09T00:00:01.000Z', '2027-09-19T00:00:00.000Z')],
      // Starts after the span, or ends before its end.
      [s('late', '2027-09-05T00:00:01.000Z', '2027-09-20T00:00:00.000Z')],
      [s('short', '2027-08-31T00:00:00.000Z', '2027-09-18T23:59:59.000Z')],
      // Not settled.
      [s('parked', '2027-08-31T00:00:00.000Z', '2027-09-20T00:00:00.000Z', 'needs_review'),
        s('gone', '2027-08-31T00:00:00.000Z', '2027-09-20T00:00:00.000Z', 'superseded'),
        s('half', '2027-08-31T00:00:00.000Z', '2027-09-20T00:00:00.000Z', 'in_progress')],
      [],
    ]) {
      expect(settledCoverage(rows, from, to).covered).toBe(false);
    }
    expect(settledCoverage([s('one', '2027-08-31T00:00:00.000Z', '2027-09-20T00:00:00.000Z')], Number.NaN, to).covered).toBe(false);
  });

  const incident = (over: Partial<StoreRow> & { payload?: Record<string, unknown> } = {}): StoreRow => row('i', 'firing', {
    delivery_count: 1,
    ...over,
    payload: { kind: 'pnl_failed', occurred_at: '2027-09-27T10:00:20.000Z', run_started_at: '2027-09-27T10:00:00.000Z',
      window_start: ANCHOR_END, ...over.payload },
  });

  it('must prove every window from the first window\'s earliest start through the end of the last one', () => {
    const rows = [anchor];
    // A failed call's window ended at its own now(), before the store recorded
    // the fault: the proof must reach that record, on the same database clock.
    expect(pnlRecoveryRequirement(incident(), rows)).toMatchObject({ startMs: Date.parse(ANCHOR_END),
      startText: ANCHOR_END, endMs: Date.parse('2027-09-27T10:00:30.000Z'), endBasis: 'last_record', occurrences: 1 });
    // Re-runs coalesced into it: the proof must reach the last one's record.
    expect(pnlRecoveryRequirement(incident({ delivery_count: 3, last_received_at: '2027-10-11T10:01:00.000Z' }), rows))
      .toMatchObject({ endMs: Date.parse('2027-10-11T10:01:00.000Z'), occurrences: 3 });
    // An unreadable record time can never be proved.
    expect(Number.isNaN(pnlRecoveryRequirement(incident({ delivery_count: 2, last_received_at: 'not a time' }), rows).endMs)).toBe(true);
    // The window start is never later than the one recorded when it happened...
    expect(pnlRecoveryRequirement(incident({ payload: { window_start: '2027-08-31T00:00:00.000Z' } }), rows))
      .toMatchObject({ startMs: Date.parse('2027-08-31T00:00:00.000Z') });
    // ...and is taken as of the first run when it could not be read then.
    expect(pnlRecoveryRequirement(incident({ payload: { window_start: null, window_basis: 'anchor_unreadable' } }), rows))
      .toMatchObject({ startMs: Date.parse(ANCHOR_END), window: { basis: 'chain_anchor' } });
    // A parked call is proved over its own parked window, exactly, through the last parked row of the incident.
    const parked = chainRow('parked-1', 'needs_review', '2027-09-04T00:00:00.000Z', '2027-09-27T10:00:19.000Z');
    const parkedAgain = chainRow('parked-2', 'superseded', '2027-09-04T00:00:00.000Z', '2027-10-04T10:00:19.000Z');
    const parkedLater = chainRow('parked-3', 'needs_review', '2027-10-05T00:00:00.000Z', '2027-10-11T10:00:19.000Z');
    const reviewed = incident({ delivery_count: 2, last_received_at: '2027-10-04T10:01:00.000Z',
      payload: { kind: 'pnl_needs_review', settlement_id: 'parked-1', window_start: null } });
    expect(pnlRecoveryRequirement(reviewed, [anchor, parked, parkedAgain, parkedLater])).toMatchObject({
      startText: '2027-09-04T00:00:00.000Z', endMs: Date.parse('2027-10-04T10:00:19.000Z'), endBasis: 'parked_row',
      window: { basis: 'parked_row' } });
    // The exact re-run of the last parked period proves it; a re-run of the first one alone does not.
    const need = pnlRecoveryRequirement(reviewed, [anchor, parked, parkedAgain]);
    expect(settledCoverage([chainRow('rerun-2', 'settled', '2027-09-04T00:00:00.000Z', '2027-10-04T10:00:19.000Z')],
      need.startMs, need.endMs).covered).toBe(true);
    expect(settledCoverage([chainRow('rerun-1', 'settled', '2027-09-04T00:00:00.000Z', '2027-09-27T10:00:19.000Z')],
      need.startMs, need.endMs).covered).toBe(false);
  });

  // Review round 6: with the end short of the fault, a settlement that ended
  // shortly before the failed call covered the span up to that call's anchor
  // and was taken for proof, though the call may have settled from it.
  it('never counts a settlement that ended just before a failed call for proof of that call\'s window', () => {
    const just = chainRow('manual-5min', 'settled', ANCHOR_END, '2027-09-27T09:55:00.000Z');
    const need = pnlRecoveryRequirement(incident(), [anchor, just]);
    expect(settledCoverage([anchor, just], need.startMs, need.endMs).covered).toBe(false);
    const next = chainRow('weekly', 'settled', '2027-09-27T09:55:00.000Z', '2027-10-04T10:00:05.000Z');
    expect(settledCoverage([anchor, just, next], need.startMs, need.endMs))
      .toEqual({ covered: true, coveredBy: ['manual-5min', 'weekly'] });
  });

  // Review round 6: a joined incident held the window W1, which a manual
  // settlement covered, and the next window W2, which nothing settled. The
  // proof of W1 alone closed it.
  it('never counts the proof of one window for an incident that also holds a later one', () => {
    const manual = chainRow('manual-w1', 'settled', ANCHOR_END, '2027-09-30T12:00:00.000Z');
    const joined = incident({ delivery_count: 2, last_received_at: '2027-10-04T10:01:00.000Z' });
    const need = pnlRecoveryRequirement(joined, [anchor, manual]);
    expect(settledCoverage([anchor, manual], need.startMs, need.endMs).covered).toBe(false);
    const w2 = chainRow('weekly-w2', 'settled', '2027-09-30T12:00:00.000Z', '2027-10-11T10:00:05.000Z');
    expect(settledCoverage([anchor, manual, w2], need.startMs, need.endMs))
      .toEqual({ covered: true, coveredBy: ['manual-w1', 'weekly-w2'] });
  });

  // Review round 7: the anchor could not be read when the call failed, and a
  // settlement made by hand two days later, for a past span inside the failed
  // window, was taken for the anchor as of the first run. The span before it,
  // which nothing settled, was then taken for proved.
  it('never takes a chain row written after the run for the anchor, whatever past span it names', () => {
    const late = chainRow('late-partial', 'settled', '2027-09-15T00:00:00.000Z', '2027-09-19T00:00:00.000Z',
      '2027-09-29T12:00:00.000Z');
    expect(pnlWindowStart([anchor, late], RUN_START, FAULT_AT)).toEqual({ startMs: Date.parse(ANCHOR_END),
      startText: ANCHOR_END, basis: 'chain_anchor', anchorId: 'a-1', movedBy: [] });
    const unread = incident({ payload: { window_start: null, window_basis: 'anchor_unreadable' } });
    const next = chainRow('weekly', 'settled', '2027-09-19T00:00:00.000Z', '2027-10-04T10:00:05.000Z');
    const need = pnlRecoveryRequirement(unread, [anchor, late, next]);
    expect(need).toMatchObject({ startMs: Date.parse(ANCHOR_END), startBasis: 'chain_anchor' });
    expect(settledCoverage([anchor, late, next], need.startMs, need.endMs).covered).toBe(false);
    // Written within the margin of the run, the same row may have been the call's anchor.
    const near = { ...late, id: 'near-partial', settled_at: '2027-09-27T09:55:00.000Z' };
    expect(pnlWindowStart([anchor, near], RUN_START, FAULT_AT)).toMatchObject({ startMs: Date.parse(ANCHOR_END),
      basis: 'anchor_moved', anchorId: 'a-1', movedBy: ['near-partial'] });
  });

  it('starts no later than the end of any chain row the call may have seen, even one for an older span', () => {
    // No chain row before the run, and a settlement of an old span written 5 minutes before it.
    const old = chainRow('old-span', 'settled', '2027-07-31T00:00:00.000Z', '2027-08-07T00:00:00.000Z',
      '2027-09-27T09:55:00.000Z');
    expect(pnlWindowStart([old], RUN_START, FAULT_AT)).toEqual({ startMs: Date.parse('2027-08-07T00:00:00.000Z'),
      startText: '2027-08-07T00:00:00.000Z', basis: 'anchor_moved', anchorId: null, movedBy: ['old-span'] });
    // A write time that cannot be read is never taken for one the call certainly saw.
    const unknown = chainRow('no-time', 'settled', '2027-09-15T00:00:00.000Z', '2027-09-19T00:00:00.000Z', null);
    expect(pnlWindowStart([anchor, unknown], RUN_START, FAULT_AT)).toEqual({ startMs: Date.parse(ANCHOR_END),
      startText: ANCHOR_END, basis: 'anchor_moved', anchorId: 'a-1', movedBy: ['no-time'] });
  });

  // Review round 7: the proof had to reach 10 minutes past the fault by the
  // worker's clock, so a re-run minutes later that settled the failed window
  // proved nothing, and nothing ever did once the chain then skipped a span.
  it('is proved by a settlement that reaches the store\'s own record of the fault, and never by one that ended before it', () => {
    const need = pnlRecoveryRequirement(incident(), [anchor]);
    // A re-run 5 minutes after the fault settled from the anchor through its own now().
    const rerun = chainRow('rerun', 'settled', ANCHOR_END, '2027-09-27T10:05:00.000Z');
    expect(settledCoverage([anchor, rerun], need.startMs, need.endMs)).toEqual({ covered: true, coveredBy: ['rerun'] });
    // Ended before the record: it may have been the failed call's own anchor.
    const before = chainRow('before', 'settled', ANCHOR_END, '2027-09-27T10:00:29.999Z');
    expect(settledCoverage([anchor, before], need.startMs, need.endMs).covered).toBe(false);
    // A re-run that joined the incident is proved only through its own record.
    const joined = pnlRecoveryRequirement(incident({ delivery_count: 2, last_received_at: '2027-10-04T10:00:30.000Z' }),
      [anchor]);
    expect(settledCoverage([anchor, rerun], joined.startMs, joined.endMs).covered).toBe(false);
  });
});

describe('every read is paged to its end', () => {
  // A table of n rows with ids 1..n, answered as PostgREST answers
  // `id > after ... order by id limit PAGE_ROWS`.
  const table = (n: number) => (after: unknown) => {
    const from = after === null ? 1 : Number(after) + 1;
    const count = Math.max(0, Math.min(PAGE_ROWS, n - from + 1));
    return Promise.resolve({ data: Array.from({ length: count }, (_, i) => ({ id: from + i })), error: null });
  };

  // Review round 7: the text said a read fails above 10,000 rows. It fails at
  // 10,000: a full last page cannot prove there is no more.
  it('decides with 9,999 matching rows, and cannot decide with 10,000 or more', async () => {
    expect(MAX_PAGES * PAGE_ROWS).toBe(10_000);
    expect(await readPages('rows', table(9_999))).toHaveLength(9_999);
    for (const n of [10_000, 10_001]) {
      const error = await readPages('rows', table(n)).then(() => null, (err: unknown) => err);
      expect(error).toBeInstanceOf(OperationalAlertDeliveryError);
      expect(String((error as Error).message)).toContain('rows: 10000 or more rows match; cannot decide');
    }
  });
});

describe('a rule violation is one incident per broken invariant', () => {
  it('counts each invariant once, with its offenders summed', () => {
    expect(distinctViolations([
      { invariant: 'negative_balance', severity: 'critical', offenders: 1 },
      { invariant: 'money_fn_exposed_to_anon', severity: 'critical', offenders: 3 },
      { invariant: 'negative_balance', severity: 'critical', offenders: 2 },
    ])).toEqual([
      { invariant: 'negative_balance', severity: 'critical', offenders: 3 },
      { invariant: 'money_fn_exposed_to_anon', severity: 'critical', offenders: 3 },
    ]);
  });

  it('clears an invariant a complete check no longer reports, and nothing it still reports', () => {
    const at = Date.parse('2027-10-04T10:00:30.000Z');
    const rule = (key: string, invariant: unknown, over: Partial<StoreRow> = {}) => row(key, 'firing', {
      alertname: 'UnionRuleViolation',
      payload: { occurred_at: '2027-09-27T10:00:20.000Z', ...(invariant === undefined ? {} : { invariant }) },
      ...over,
    });
    const rows = [rule('fixed', 'negative_balance'), rule('still', 'money_fn_exposed_to_anon'),
      rule('unnamed', undefined), rule('recovered', 'orphan'), row(resolutionKey('recovered'), 'resolved'),
      rule('closed', 'orphan', { investigation_status: 'test' }),
      rule('after', 'orphan', { payload: { occurred_at: '2027-10-04T10:00:31.000Z', invariant: 'orphan' } })];
    const cleared = (critical: string[]) => ruleFaultsCleared(rows, new Set(critical), at).map((r) => r.event_key);
    expect(cleared(['money_fn_exposed_to_anon'])).toEqual(['fixed']);
    expect(cleared([])).toEqual(['fixed', 'still', 'unnamed']);
  });
});

describe('what counts as a settlement problem notice', () => {
  it('compares titles with ASCII case folded and ASCII whitespace runs collapsed, and nothing else', () => {
    expect(normalizeTitle(' \tWeekly  PLAYER\n\v\f\rP&L   failed  ')).toBe('weekly player p&l failed');
    // Not ASCII whitespace or ASCII letters (a no-break space, the Kelvin sign): left as they are, in SQL too.
    const noBreakSpace = String.fromCharCode(0xa0);
    const kelvin = String.fromCharCode(0x212a);
    expect(normalizeTitle(`Weekly${noBreakSpace}player P&L failed`)).toBe(`weekly${noBreakSpace}player p&l failed`);
    expect(normalizeTitle(`WEE${kelvin}LY player P&L failed`)).toBe(`wee${kelvin}ly player p&l failed`);
  });

  it('knows each problem by its title in any case or spacing, and nothing that only quotes it', () => {
    for (const [kind, problem] of Object.entries(SETTLEMENT_PROBLEMS)) {
      for (const variant of [problem.title, problem.title.toUpperCase(), `  ${problem.title.replace(/ /g, ' \t ')}\n`]) {
        expect(problemKindOfTitle(variant)).toBe(kind);
      }
    }
    for (const other of [`Resolved: ${SETTLEMENT_PROBLEMS.pnl_failed.title}`, 'Settlement Complete - Club One Period #7',
      'Weekly player P&L', null, 42]) {
      expect(problemKindOfTitle(other)).toBeNull();
    }
  });

  it('knows each problem by its marker whatever the title, and only this sender\'s marker', () => {
    for (const kind of Object.keys(SETTLEMENT_PROBLEMS) as Array<keyof typeof SETTLEMENT_PROBLEMS>) {
      expect(problemKindOfMarker(problemNoticeMarker(kind))).toBe(kind);
    }
    for (const data of [
      { component: 'another.sender', alertname: 'UnionPlayerPnlFailed' },
      { component: 'workers.auto-settlement', alertname: 'SomethingElse' },
      { component: 'workers.auto-settlement', alertname: ['UnionPlayerPnlFailed'] },
      { alertname: 'UnionPlayerPnlFailed' },
      { needs_review: true }, { failed: true }, { governance_check: true },
      [{ component: 'workers.auto-settlement', alertname: 'UnionPlayerPnlFailed' }], null, 'x',
    ]) {
      expect(problemKindOfMarker(data)).toBeNull();
    }
  });

  it('marks each notice with this sender and the alertname and severity its incident is recorded under', () => {
    expect(problemNoticeMarker('pnl_needs_review'))
      .toEqual({ component: 'workers.auto-settlement', alertname: 'UnionPlayerPnlNeedsReview', severity: 'warning' });
    expect(problemNoticeMarker('pnl_failed'))
      .toEqual({ component: 'workers.auto-settlement', alertname: 'UnionPlayerPnlFailed', severity: 'critical' });
    expect(problemNoticeMarker('rule_violation'))
      .toEqual({ component: 'workers.auto-settlement', alertname: 'UnionRuleViolation', severity: 'critical' });
  });

  // The database classifier (fn_is_owner_operational_notification) and its
  // World Hub mirror must match exactly this. Changing it changes them.
  it('is exactly the settlement clause handed to the database classifier', () => {
    expect(SETTLEMENT_PROBLEM_CLASSIFIER).toEqual({
      type: 'settlement',
      normalizedTitles: ['weekly player p&l needs review', 'weekly player p&l failed', 'union rule violation detected'],
      component: 'workers.auto-settlement',
      alertnames: ['UnionPlayerPnlNeedsReview', 'UnionPlayerPnlFailed', 'UnionRuleViolation'],
    });
    const notice = { type: 'settlement', title: 'Weekly player P&L failed', data: {} };
    expect(settlementProblemKind(notice)).toBe('pnl_failed');
    expect(settlementProblemKind({ ...notice, type: 'system' })).toBeNull();
    expect(settlementProblemKind({ type: 'settlement', title: 'Reworded', data: problemNoticeMarker('rule_violation') }))
      .toBe('rule_violation');
  });

  it('reads with a server-side filter that returns every title the client check keeps', () => {
    const ilike = (pattern: string) => new RegExp(`^${pattern.replace(/\*/g, '.*')}$`, 'is');
    // Only letters and the wildcard: nothing PostgREST reserves inside or=(...).
    for (const pattern of PROBLEM_TITLE_PATTERNS) expect(/^[a-z*]+$/.test(pattern)).toBe(true);
    // Deterministic variants (mulberry32): ASCII case flips and whitespace runs between and around the words.
    let seed = 7;
    const next = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    const seen = new Set<string>();
    const spaces = [' ', '\t', '\n', '\v', '\f', '\r'];
    const gap = () => Array.from({ length: 1 + next(3) }, () => spaces[next(spaces.length)]).join('');
    for (const { title } of Object.values(SETTLEMENT_PROBLEMS)) {
      for (let i = 0; i < 200; i += 1) {
        const words = title.split(' ').map((word) => [...word].map((c) => (next(2) ? c.toUpperCase() : c.toLowerCase())).join(''));
        const variant = `${next(2) ? gap() : ''}${words.join(gap())}${next(2) ? gap() : ''}`;
        seen.add(variant);
        expect(problemKindOfTitle(variant)).not.toBeNull();
        expect(PROBLEM_TITLE_PATTERNS.some((p) => ilike(p).test(variant))).toBe(true);
      }
    }
    // The variants really vary.
    expect(seen.size).toBeGreaterThan(500);
  });
});

describe('a leak is a problem notice in the personal inbox, or a problem push still queued', () => {
  const note = (id: string, title: string, data: Record<string, unknown> = {}, type = 'settlement') => ({ id, type, title, data });
  const push = (id: string, status: string, title = 'Weekly player P&L failed', event = 'settlement') =>
    ({ id, event, title, status, related_entity_id: null });

  it('keeps problem notices by title or marker, and pushes only while queued', () => {
    const present = presentLeaks(
      [note('n-1', ' weekly  PLAYER p&l failed '), note('n-2', 'Settlement Complete'),
        note('n-3', 'Anything', { needs_review: true }), note('n-4', 'Resolved: Weekly player P&L failed'),
        note('n-5', 'Reworded', { component: 'workers.auto-settlement', alertname: 'UnionPlayerPnlNeedsReview' }),
        note('n-6', 'Weekly player P&L failed', {}, 'system')],
      [push('p-1', 'pending'), push('p-2', 'processing'), push('p-3', 'sent'), push('p-4', 'skipped'),
        push('p-5', 'failed'), push('p-6', 'pending', 'Anything'), push('p-7', 'pending', 'Weekly player P&L failed', 'system')],
    );
    expect(present.notes.map((n) => n.id)).toEqual(['n-1', 'n-5']);
    expect(present.pushes.map((p) => p.id)).toEqual(['p-1', 'p-2']);
  });

  it('treats a sent push as delivered and only a skipped or failed one as never reaching the phone', () => {
    expect(['pending', 'processing', 'sent', 'skipped', 'failed', undefined, 'other'].map(pushOutcome))
      .toEqual(['queued', 'queued', 'delivered', 'undelivered', 'undelivered', 'unknown', 'unknown']);
  });
});

describe('failure evidence', () => {
  it('reads the message and code of a PostgREST error object instead of "[object Object]"', () => {
    expect(errorEvidence({ message: 'pnl_union_wallet_missing', code: 'P0001', details: 'club x', hint: null }))
      .toEqual({ message: 'pnl_union_wallet_missing', code: 'P0001' });
    expect(errorEvidence(new Error('boom'))).toEqual({ message: 'boom', code: null });
    expect(errorEvidence('plain')).toEqual({ message: 'plain', code: null });
    expect(errorEvidence({ message: 'x'.repeat(900) }).message).toHaveLength(503);
  });
});
