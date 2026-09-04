/**
 * What a cron run leaves behind in `cron_execution_log`.
 *
 * The column was `{}` on all 4,110 rows this middleware had written, which is
 * why the collusion detector's death took a person reading source to diagnose:
 * a run that read 200 hands cleanly and a run that stopped dead 40,000 rows
 * into a six-hour backlog were the same green row. The handlers were returning
 * all of it and the log was discarding it.
 *
 * These cases pin the two properties that matter as much as capturing it:
 * logging never changes what a cron returns, and it never grows without bound.
 */
import { describe, expect, it } from 'vitest';
import { RESULT_MAX_BYTES, readResultSummary } from './cronResultSummary.js';

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });

describe('readResultSummary', () => {
  it('keeps the body a handler returned', async () => {
    const r = await readResultSummary(json({ scanned_hands: 40_000, read_complete: false }));
    expect(r).toEqual({ scanned_hands: 40_000, read_complete: false });
  });

  it('leaves the response readable by the caller', async () => {
    // It clones. If it consumed the body instead, every cron would answer an
    // already-read stream and the fix would be worse than the defect.
    const res = json({ ok: true });
    await readResultSummary(res);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('bounds a large body instead of writing it whole', async () => {
    const big = json({ blob: 'x'.repeat(RESULT_MAX_BYTES * 2) });
    const r = await readResultSummary(big);
    expect(r.truncated).toBe(true);
    expect(typeof r.bytes).toBe('number');
    expect(String(r.head).length).toBeLessThanOrEqual(500);
  });

  it('answers an empty object rather than throwing on anything it cannot read', async () => {
    expect(await readResultSummary(undefined)).toEqual({});
    expect(await readResultSummary(new Response('not json'))).toEqual({});
    expect(
      await readResultSummary(
        new Response('{oops', { headers: { 'content-type': 'application/json' } }),
      ),
    ).toEqual({});
  });

  it('wraps a non-object JSON body so the column stays an object', async () => {
    expect(await readResultSummary(json([1, 2, 3]))).toEqual({ value: [1, 2, 3] });
  });
});
