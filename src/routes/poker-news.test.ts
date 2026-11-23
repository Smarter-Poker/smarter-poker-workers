import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  newsSources: vi.fn(),
  archivedUrls: new Set<string>(),
  insertedNews: [] as Array<Record<string, unknown>>,
  rpcPosts: [] as Array<Record<string, unknown>>,
}));

vi.mock('../lib/content-engine/ClipSupply.js', () => ({
  newsSources: mocks.newsSources,
}));

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    rpc: (_fn: string, params: Record<string, unknown>) => {
      mocks.rpcPosts.push(params);
      return Promise.resolve({ data: { id: 'post-1' }, error: null });
    },
    from: (table: string) => {
      const state: { op: 'select' | 'insert' | 'update'; url?: string } = { op: 'select' };
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.ilike = () => b;
      b.gte = () => b;
      b.limit = () => b;
      b.eq = (col: string, val: string) => {
        if (col === 'source_url') state.url = val;
        return b;
      };
      b.insert = (row: Record<string, unknown>) => {
        state.op = 'insert';
        mocks.insertedNews.push(row);
        return b;
      };
      b.update = () => {
        state.op = 'update';
        return b;
      };
      b.maybeSingle = () => {
        if (table === 'poker_news' && state.op === 'insert') {
          return Promise.resolve({ data: { id: 'news-1' }, error: null });
        }
        if (table === 'poker_news' && state.url && mocks.archivedUrls.has(state.url)) {
          return Promise.resolve({ data: { id: 'existing-news' }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      };
      b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve, reject);
      return b;
    },
  }),
}));

import { pokerNews } from './poker-news.js';

function context() {
  let captured: { body: Record<string, unknown>; status: number } = { body: {}, status: 200 };
  return {
    json: (body: Record<string, unknown>, status = 200) => {
      captured = { body, status };
      return captured;
    },
    get captured() {
      return captured;
    },
  };
}

const VALID_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>PokerNews</title>
<item>
  <title>WSOP Main Event Day 4 Leaders</title>
  <link>https://www.pokernews.com/news/wsop-day-4.htm</link>
  <pubDate>Mon, 23 Nov 2026 12:00:00 GMT</pubDate>
  <description>Coverage from the tournament floor.</description>
</item>
</channel></rss>`;

const originalFetch = globalThis.fetch;

beforeEach(() => {
  mocks.newsSources.mockReset();
  mocks.archivedUrls.clear();
  mocks.insertedNews = [];
  mocks.rpcPosts = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('poker-news route', () => {
  it('reads active RSS feeds from content_sources, validates XML, archives and posts', async () => {
    mocks.newsSources.mockResolvedValue([
      { id: '1', name: 'PokerNews', feed_url: 'https://www.pokernews.com/rss.php', fallback_urls: null },
      { id: '2', name: 'Poker.org', feed_url: 'https://www.poker.org/', fallback_urls: null },
    ]);
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === 'https://www.pokernews.com/rss.php') return new Response(VALID_RSS, { status: 200 });
      return new Response('<!doctype html><html><body>Homepage</body></html>', { status: 200 });
    }) as unknown as typeof fetch;

    const c = context();
    await pokerNews(c as never);

    expect(c.captured.status).toBe(200);
    expect(c.captured.body).toMatchObject({
      success: true,
      posted: 1,
      post_id: 'post-1',
      news_id: 'news-1',
      feeds_attempted: 2,
      feeds_succeeded: 1,
    });
    expect(mocks.insertedNews).toHaveLength(1);
    expect(mocks.rpcPosts).toHaveLength(1);
  });

  it('returns HTTP 503 with success:false when every configured feed fails instead of lying "No news available"', async () => {
    mocks.newsSources.mockResolvedValue([
      { id: '1', name: 'PokerNews', feed_url: 'https://www.pokernews.com/rss.php', fallback_urls: null },
    ]);
    globalThis.fetch = vi.fn(async () => new Response('Forbidden', { status: 403 })) as unknown as typeof fetch;

    const c = context();
    await pokerNews(c as never);

    expect(c.captured.status).toBe(503);
    expect(c.captured.body).toMatchObject({
      success: false,
      error: 'all_news_feeds_failed',
      feeds_attempted: 1,
      feeds_succeeded: 0,
      posted: 0,
    });
  });
});
