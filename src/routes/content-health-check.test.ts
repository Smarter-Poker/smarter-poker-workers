import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentHealthCheck, isValidFeedBody } from './content-health-check.js';

const db = vi.hoisted(() => ({
  updateCount: 0,
  updates: [] as Array<{ feed_url: string; old_url: string }>,
  logs: [] as Array<Record<string, unknown>>,
}));

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table === 'content_sources') {
        let patch: Record<string, unknown> = {};
        let eqFeed = '';
        const b: Record<string, unknown> = {};
        b.update = (p: Record<string, unknown>) => {
          patch = p;
          return b;
        };
        b.eq = (col: string, val: string) => {
          if (col === 'feed_url') eqFeed = val;
          return b;
        };
        b.then = (resolve: (v: unknown) => void) => {
          db.updates.push({ feed_url: String(patch.feed_url ?? ''), old_url: eqFeed });
          resolve({ error: null, count: db.updateCount });
        };
        return b;
      }
      if (table === 'system_logs') {
        return {
          insert: (row: Record<string, unknown>) => {
            db.logs.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

beforeEach(() => {
  db.updateCount = 0;
  db.updates = [];
  db.logs = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const context = () => ({
  json: (body: unknown) => body,
}) as unknown as Parameters<typeof contentHealthCheck>[0];

const VALID_RSS = '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Feed</title></channel></rss>';
const HTML_HOME = '<!doctype html><html><head><title>Home</title></head><body>Hi</body></html>';

describe('content-health local diagnostics', () => {
  it('retains all failed-source results and a local warning', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('err', { status: 503 })));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await contentHealthCheck(context()) as unknown as {
      success: boolean; healthy: number; failed: number; needs_attention: string[];
    };
    expect(result.success).toBe(false);
    expect(result.healthy).toBe(0);
    expect(result.failed).toBe(7);
    expect(result.needs_attention).toHaveLength(7);
    expect(db.updates).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[content-health-check] 7 sources need manual attention',
      expect.objectContaining({ failed_sources: result.needs_attention }),
    );
  });

  it('returns the original failures when the local log sink throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('err', { status: 503 })));
    vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('stderr unavailable'); });
    expect(await contentHealthCheck(context())).toMatchObject({ success: false, failed: 7, healthy: 0 });
  });

  it('keeps healthy-source results quiet when RSS feeds serve real XML', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response(VALID_RSS, { status: 200 })),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await contentHealthCheck(context())).toMatchObject({ success: true, failed: 0, healthy: 7 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects HTML homepages returned with HTTP 200 for RSS feeds and never overwrites content_sources', async () => {
    expect(isValidFeedBody(VALID_RSS)).toBe(true);
    expect(isValidFeedBody(HTML_HOME)).toBe(false);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response(HTML_HOME, { status: 200 })),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await contentHealthCheck(context()) as unknown as {
      healthy: number; failed: number; auto_fixed: number; sources: Array<{ name: string; status: string }>;
    };
    // 3 HTML sources (MSPT, WSOP, Pokerfuse) are healthy; 4 RSS sources fail and are NOT auto-fixed to HTML.
    expect(result.healthy).toBe(3);
    expect(result.failed).toBe(4);
    expect(result.auto_fixed).toBe(0);
    expect(db.updates).toEqual([]);
  });

  it('only reports auto_fixed when content_sources was actually updated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: unknown) => {
        const url = String(input);
        if (url === 'https://www.pokernews.com/rss.php') return new Response('gone', { status: 404 });
        return new Response(VALID_RSS, { status: 200 });
      }),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // When rows_updated === 0, must NOT lie auto_fixed.
    db.updateCount = 0;
    const notApplied = await contentHealthCheck(context()) as unknown as {
      auto_fixed: number; failed: number; sources: Array<{ name: string; status: string }>;
    };
    expect(notApplied.auto_fixed).toBe(0);
    expect(notApplied.failed).toBe(1);
    expect(notApplied.sources.find((s) => s.name === 'PokerNews')?.status).toBe('fallback_not_applied');

    // When rows_updated === 1, reports auto_fixed.
    db.updateCount = 1;
    const applied = await contentHealthCheck(context()) as unknown as {
      auto_fixed: number; failed: number; sources: Array<{ name: string; status: string }>;
    };
    expect(applied.auto_fixed).toBe(1);
    expect(applied.failed).toBe(0);
    expect(applied.sources.find((s) => s.name === 'PokerNews')?.status).toBe('auto_fixed');
  });
});
