/**
 * Recertification D3 (2026-09-21): PokerNews reels are gated by the fleet
 * switch like every other route that posts under a content_authors profile.
 * With the engine off (or unreadable, which engineEnabled reports as off)
 * the run touches neither the feed nor the database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const io = vi.hoisted(() => ({ feed: vi.fn(), query: vi.fn(), engineEnabled: vi.fn() }));
vi.mock('rss-parser', () => ({ default: class { parseURL = io.feed; } }));
vi.mock('../lib/supabase.js', () => ({ getSupabase: () => ({ from: io.query }) }));
vi.mock('../lib/content-engine/Fleet.js', () => ({ engineEnabled: io.engineEnabled }));
import { pokernewsVideos } from './pokernews-videos.js';

async function run() {
  const app = new Hono();
  app.get('/cron/pokernews-videos', pokernewsVideos);
  const res = await app.request('/cron/pokernews-videos');
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  io.feed.mockReset();
  io.query.mockReset();
  io.engineEnabled.mockReset();
  io.feed.mockResolvedValue({ items: [] });
  io.query.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      ilike: () => chain,
      not: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: { id: 1, profile_id: 'publisher' }, error: null }),
      insert: async () => ({ error: null }),
    });
    return chain;
  });
});

describe('the PokerNews route fails closed on the fleet switch', () => {
  it('with the engine off it reads no feed and touches no table', async () => {
    io.engineEnabled.mockResolvedValue(false);
    const r = await run();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, skipped: 'engine_disabled' });
    expect(io.feed).not.toHaveBeenCalled();
    expect(io.query).not.toHaveBeenCalled();
  });

  it('with the engine on it runs as before', async () => {
    io.engineEnabled.mockResolvedValue(true);
    const r = await run();
    expect(r.status).toBe(200);
    expect(io.feed).toHaveBeenCalledTimes(1);
    expect(r.body).toMatchObject({ success: true, results: { found: 0, imported: 0 } });
  });
});
