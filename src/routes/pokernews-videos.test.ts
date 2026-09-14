import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const io = vi.hoisted(() => ({ feed: vi.fn(), query: vi.fn(), writes: vi.fn() }));
vi.mock('rss-parser', () => ({ default: class { parseURL = io.feed; } }));
vi.mock('../lib/supabase.js', () => ({ getSupabase: () => ({ from: io.query }) }));
import { pokernewsVideos } from './pokernews-videos.js';

const item = (n: number) => ({ link: `https://www.youtube.com/watch?v=video${n}`, title: `Video ${n}`, isoDate: '2026-09-13T06:00:00Z' });
const author = { data: { id: 1, profile_id: 'publisher' }, error: null };
const empty = { data: null, error: null };
let authors: typeof author | { data: null; error: { message: string } | null };
let lookups: Array<{ data: { id: string } | null; error: { message: string } | null }>;

async function run() {
  const app = new Hono();
  app.get('/cron/pokernews-videos', pokernewsVideos);
  const res = await app.request('/cron/pokernews-videos');
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  authors = author;
  lookups = [empty];
  io.feed.mockResolvedValue({ items: [item(1)] });
  io.writes.mockResolvedValue({ error: null });
  io.query.mockImplementation((table: string) => {
    const chain = {
      select: () => chain, ilike: () => chain, not: () => chain, eq: () => chain,
      maybeSingle: async () => table === 'content_authors' ? authors : lookups.shift() ?? empty,
      insert: io.writes,
    };
    return chain;
  });
});
afterEach(() => { vi.useRealTimers(); });

describe('PokerNews receipts describe the work that finished', () => {
  it('records an RSS 404 as failure with no database writes', async () => {
    io.feed.mockRejectedValue(new Error('Status code 404'));
    const r = await run();
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ success: false, results: { found: 0, imported: 0, errors: ['RSS fetch failed: Status code 404'] } });
    expect(io.query).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds a silent RSS response and records the timeout', async () => {
    io.feed.mockReturnValue(new Promise(() => {}));
    const pending = run();
    await vi.advanceTimersByTimeAsync(15000);
    const r = await pending;
    expect(r.status).toBe(503);
    expect(r.body.results.errors[0]).toContain('did not answer within 15000ms');
    expect(io.writes).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves a database author lookup failure instead of mislabeling configuration', async () => {
    authors = { data: null, error: { message: 'database unavailable' } };
    const r = await run();
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('PokerNews author lookup failed: database unavailable');
    expect(io.writes).not.toHaveBeenCalled();
  });
  it('continues to refuse an unconfigured publisher without using another account', async () => {
    authors = { data: null, error: null };
    const r = await run();
    expect(r.status).toBe(500);
    expect(r.body.error).toContain('refusing arbitrary attribution');
    expect(io.writes).not.toHaveBeenCalled();
  });
  it('does not insert after an inconclusive duplicate lookup', async () => {
    lookups = [{ data: null, error: { message: 'lookup unavailable' } }];
    const r = await run();
    expect(r.status).toBe(503);
    expect(r.body.results.errors).toEqual(['Video lookup failed: lookup unavailable']);
    expect(io.writes).not.toHaveBeenCalled();
  });
  it('retains committed progress while reporting a failed insert as partial failure', async () => {
    io.feed.mockResolvedValue({ items: [item(1), item(2)] });
    io.writes.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: 'insert refused' } });
    const r = await run();
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ success: false, results: { found: 2, imported: 1, skipped: 0 } });
    expect(r.body.results.errors).toEqual(['Failed to insert "Video 2": insert refused']);
    expect(io.writes).toHaveBeenCalledTimes(2);
  });
  it('reports a verified duplicate as a successful no-op', async () => {
    lookups = [{ data: { id: 'existing' }, error: null }];
    const r = await run();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, results: { found: 1, imported: 0, skipped: 1, errors: [] } });
    expect(io.writes).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps the configured publisher and fields for a successful new video', async () => {
    const r = await run();
    expect(r.status).toBe(200);
    expect(r.body.results.imported).toBe(1);
    expect(io.writes).toHaveBeenCalledWith({ video_url: item(1).link, caption: item(1).title, created_at: item(1).isoDate, is_public: true, author_id: 'publisher' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not count a malformed feed item as a successful import', async () => {
    io.feed.mockResolvedValue({ items: [{ title: 'missing URL' }] });
    const r = await run();
    expect(r.status).toBe(503);
    expect(r.body.results.errors).toEqual(['Feed item has no video URL']);
    expect(io.writes).not.toHaveBeenCalled();
  });
});
