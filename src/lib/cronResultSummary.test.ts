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
  it.each([28, 80])('retains exact publication counters and IDs for %i creations without diagnostic bulk', async (count) => {
    const ids = Array.from({length:count},(_,i)=>`${String(i).padStart(8,'0')}-1111-4111-8111-111111111111`);
    const body = {success:true, attempted:count, posted:count, failed:0, unknown:0, deadline_hit:false,
      delivery:{acknowledged:count,created:count,replayed:0,creation_unknown:0,public_persisted:count,not_public:0,visibility_unknown:0,endpoint_verified:0,pairs:ids.map(postId=>({postId,diagnostic:'x'.repeat(500)}))},
      post_ids:ids,reel_ids:ids,supply:{diagnostic:'x'.repeat(12_000)}};
    const result=await readResultSummary(json(body));
    expect(result).toMatchObject({success:true,posted:count,failed:0,unknown:0,deadline_hit:false,post_ids:ids,reel_ids:ids});
    expect(result.delivery).toMatchObject({created:count,public_persisted:count,creation_unknown:0,visibility_unknown:0});
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(RESULT_MAX_BYTES);
    expect(result.truncated).not.toBe(true);
  });
  it('keeps the body a handler returned', async () => {
    const r = await readResultSummary(json({ scanned_hands: 40_000, read_complete: false }));
    expect(r).toEqual({ scanned_hands: 40_000, read_complete: false });
  });

  it('preserves unknown outcomes and exact failure tuples while compacting', async () => {
    const failure={publicationKey:'exact-operation',outcome:'unknown',code:'57014',publicationAttempt:{assetKey:'youtube:exact',authorId:'exact-author'}};
    const result=await readResultSummary(json({success:false,posted:0,unknown:1,failed:1,halted_on_unknown:true,
      post_ids:[],reel_ids:[],delivery:{creation_unknown:1,visibility_unknown:1},publication_failures:[failure],diagnostic:'x'.repeat(9000)}));
    expect(result).toMatchObject({success:false,unknown:1,failed:1,halted_on_unknown:true,publication_failures:[failure],delivery:{creation_unknown:1,visibility_unknown:1}});
    expect(result.deadline_hit).toBeUndefined();
  });

  it('never silently slices over-cap IDs or an oversized failure tuple into a complete receipt', async () => {
    for(const body of [
      {post_ids:Array(81).fill('post'),reel_ids:[],delivery:{},blob:'x'.repeat(9000)},
      {post_ids:[],reel_ids:[],delivery:{},publication_failures:[{content:'x'.repeat(9000)}]},
    ]) expect(await readResultSummary(json(body))).toMatchObject({truncated:true});
  });

  it('enforces the limit in UTF-8 bytes, not JavaScript character count', async () => {
    expect(await readResultSummary(json({blob:'界'.repeat(3000)}))).toMatchObject({truncated:true});
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
