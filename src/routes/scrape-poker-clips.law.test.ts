/**
 * A run that could not read YouTube must not retire the channels it visited.
 *
 * Production, 2026-09-08 to 2026-09-20: every 05:20 UTC run of this route read
 * zero videos from all 25 channels it visited (sources_scanned 25,
 * handles_resolved 0, clips_found 0, requests_throttled 0 to 3), while every
 * 17:20 UTC run read 165 to 315 videos from the same registry. Each empty
 * morning read was charged to the channel, and a good evening read never
 * cleared the charge, so live channels walked to six "consecutive" failures and
 * were retired: active poker channels went 47 -> 35 -> 28 between 2026-09-18
 * and 2026-09-20, while the content-supply watchdog reported
 * "only 35 of 111 poker sources still active".
 *
 * These laws pin the repaired state transition, not the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Row {
  id: string;
  name: string;
  handle: string | null;
  channel_id: string | null;
  category: string | null;
  consecutive_failures: number;
  domain: string;
  kind: string;
  is_active: boolean;
}

const db = vi.hoisted(() => ({
  due: [] as Row[],
  updates: [] as Array<{ id: unknown; patch: Record<string, unknown> }>,
  upserted: 0,
}));

vi.mock('../lib/supabase.js', () => {
  function builder(table: string) {
    const state: { op: string; patch?: Record<string, unknown>; rows?: unknown[]; id?: unknown; eq: Array<[string, unknown]> } = { op: 'select', eq: [] };
    const b: Record<string, unknown> = {};
    const self = () => b;
    Object.assign(b, {
      select: self,
      order: self,
      limit: self,
      not: self,
      in: self,
      eq: (col: string, val: unknown) => {
        if (col === 'id') state.id = val;
        state.eq.push([col, val]);
        return b;
      },
      update: (patch: Record<string, unknown>) => {
        state.op = 'update';
        state.patch = patch;
        return b;
      },
      upsert: (rows: unknown[]) => {
        state.op = 'upsert';
        state.rows = rows;
        return b;
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        let out: unknown = { data: [], error: null };
        if (table === 'content_sources' && state.op === 'update') {
          db.updates.push({ id: state.id, patch: state.patch! });
          out = { error: null };
        } else if (table === 'content_sources') {
          const rows = db.due.filter((r) =>
            state.eq.every(([col, val]) => (r as unknown as Record<string, unknown>)[col] === val),
          );
          out = { data: rows, error: null };
        } else if (table === 'poker_clips' && state.op === 'upsert') {
          db.upserted += state.rows!.length;
          out = { error: null, count: state.rows!.length };
        } else if (table === 'poker_clips') {
          out = { count: 2137, error: null };
        }
        return Promise.resolve(out).then(resolve, reject);
      },
    });
    return b;
  }
  return { getSupabase: () => ({ from: (table: string) => builder(table) }) };
});

vi.mock('../lib/content-engine/ClipSupply.js', () => ({
  pokerChannelIndex: vi.fn(async () => ({ byName: new Map(), rawNames: [] })),
}));

import { resolveChannelId, scrapePokerClips, sourcePatch, isAtomFeed } from './scrape-poker-clips.js';

const NOW = new Date('2026-09-20T05:20:00.000Z');
const channelId = (i: number) => `UC${String(i).padStart(22, 'A')}`;
const videoId = (i: number, j: number) => `v${String(i).padStart(5, '0')}x${String(j).padStart(4, '0')}`;

function row(i: number, failures: number, withChannel = true): Row {
  return {
    id: `src-${i}`,
    name: `Channel ${i}`,
    handle: `@channel${i}`,
    channel_id: withChannel ? channelId(i) : null,
    category: 'clip',
    consecutive_failures: failures,
    domain: 'poker',
    kind: 'youtube_channel',
    is_active: true,
  };
}

function atomFeed(i: number, published: string[]): string {
  const entries = published
    .map(
      (p, j) =>
        `<entry><id>yt:video:${videoId(i, j)}</id><yt:videoId>${videoId(i, j)}</yt:videoId>` +
        `<title>Hand ${j} from channel ${i}</title><published>${p}</published></entry>`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" ' +
    'xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">' +
    `<title>Channel ${i}</title>${entries}<!--${' '.repeat(6000)}--></feed>`
  );
}

/** A full-size 200 that is not a feed and names no channel: a consent or bot-check page. */
const interstitial = '<html><head><title>Before you continue to YouTube</title></head><body>' + 'x'.repeat(9000) + '</body></html>';

type Responder = (url: string) => Response | Promise<Response>;

function context() {
  let captured: { body: Record<string, unknown>; status: number } = { body: {}, status: 0 };
  return {
    json: (body: Record<string, unknown>, status?: number) => {
      captured = { body, status: status ?? 200 };
      return captured;
    },
    get captured() {
      return captured;
    },
  };
}

async function run(responder: Responder) {
  globalThis.fetch = vi.fn(async (input: unknown) => responder(String(input))) as unknown as typeof fetch;
  const c = context();
  const pending = scrapePokerClips(c as never);
  await vi.runAllTimersAsync();
  await pending;
  return c.captured.body;
}

const patchFor = (i: number) => db.updates.filter((u) => u.id === `src-${i}`).map((u) => u.patch);

const originalFetch = globalThis.fetch;
beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  db.due = [];
  db.updates = [];
  db.upserted = 0;
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

describe('a run that could not read YouTube retires nothing', () => {
  it('the exact 2026-09-20 05:20 UTC shape: 25 channels one step from retirement, nothing readable', async () => {
    // 22 channels with a cached id, 3 still waiting on handle resolution; all
    // at five charges, so the old rule retired every one YouTube failed to serve.
    db.due = Array.from({ length: 25 }, (_, i) => row(i, 5, i >= 3));
    const body = await run((url) => {
      if (url.includes(channelId(4))) return new Response('forbidden', { status: 403 });
      if (url.includes(channelId(5))) return new Response('<html>slow down</html>', { status: 200 });
      if (url.includes(channelId(6)) || url.includes(channelId(7))) return new Response('gone?', { status: 404 });
      return new Response(interstitial, { status: 200 });
    });

    expect(body).toMatchObject({
      success: true,
      sources_scanned: 25,
      handles_resolved: 0,
      clips_found: 0,
      sources_retired: 0,
      feeds_read: 0,
      youtube_answered: false,
      failures_charged: 0,
    });
    // Every channel was visited and moved to the back of the queue ...
    expect(new Set(db.updates.map((u) => u.id)).size).toBe(25);
    for (const { patch } of db.updates) {
      expect(Date.parse(String(patch.last_scraped_at))).toBeGreaterThanOrEqual(NOW.getTime());
      // ... and not one of them was charged, cleared or retired.
      expect(patch).not.toHaveProperty('is_active');
      expect(patch).not.toHaveProperty('consecutive_failures');
      expect(patch).not.toHaveProperty('last_ok_at');
    }
  });
});

describe('consecutive means consecutive', () => {
  it('a good read clears the count, however many charges came before it', async () => {
    db.due = [row(1, 5)];
    const body = await run((url) =>
      url.includes(channelId(1))
        ? new Response(atomFeed(1, ['2026-09-19T12:00:00+00:00', '2026-09-18T12:00:00+00:00']), { status: 200 })
        : new Response('unexpected', { status: 500 }),
    );
    expect(body).toMatchObject({ clips_found: 2, feeds_read: 1, sources_retired: 0, youtube_answered: true });
    expect(patchFor(1)).toEqual([
      expect.objectContaining({ consecutive_failures: 0, clips_found: 2, last_ok_at: NOW.toISOString() }),
    ]);
    expect(patchFor(1)[0]).not.toHaveProperty('is_active');
  });
});

describe('only YouTube saying "gone" counts, and only while YouTube is answering', () => {
  it('a 404 channel is charged in a readable run and retired on the sixth consecutive charge', async () => {
    db.due = [row(1, 0), row(2, 5)];
    const body = await run((url) =>
      url.includes(channelId(1))
        ? new Response(atomFeed(1, ['2026-09-19T12:00:00+00:00']), { status: 200 })
        : new Response('not found', { status: 404 }),
    );
    expect(body).toMatchObject({ youtube_answered: true, failures_charged: 1, sources_retired: 1 });
    expect(patchFor(2)).toEqual([expect.objectContaining({ consecutive_failures: 6, is_active: false })]);
  });

  it('403, the throttle page and a non-feed 200 are never charged, even while other feeds read fine', async () => {
    db.due = [row(1, 0), row(2, 5), row(3, 5), row(4, 5)];
    const body = await run((url) => {
      if (url.includes(channelId(1))) return new Response(atomFeed(1, ['2026-09-19T12:00:00+00:00']), { status: 200 });
      if (url.includes(channelId(2))) return new Response('forbidden', { status: 403 });
      if (url.includes(channelId(3))) return new Response('<html>throttled</html>', { status: 200 });
      return new Response(interstitial, { status: 200 });
    });
    expect(body).toMatchObject({ youtube_answered: true, failures_charged: 0, sources_retired: 0, requests_throttled: 3 });
    for (const i of [2, 3, 4]) {
      const [patch] = patchFor(i);
      expect(patch).not.toHaveProperty('consecutive_failures');
      expect(patch).not.toHaveProperty('is_active');
      expect(patch).not.toHaveProperty('last_ok_at');
    }
  });

  it('a handle page that names no channel is a non-answer, not a missing handle', async () => {
    globalThis.fetch = vi.fn(async () => new Response(interstitial, { status: 200 })) as unknown as typeof fetch;
    const r = await resolveChannelId('@SomeRealChannel');
    expect(r).toEqual({ channelId: null, throttled: false, outcome: 'no-answer' });
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    expect((await resolveChannelId('@GoneForever')).outcome).toBe('missing');
  });
});

describe('the channel scraper walks channels, not news feeds', () => {
  it('a poker news feed row is never visited, charged or retired, even while YouTube is answering', async () => {
    // 2026-09-13..15: CardPlayer, Poker.org, PokerNews and Upswing Poker News
    // (kind 'rss', no handle, no channel id) were each charged six times by this
    // route and retired, leaving poker news with no active source.
    const news: Row = {
      id: 'src-news',
      name: 'PokerNews',
      handle: null,
      channel_id: null,
      category: null,
      consecutive_failures: 5,
      domain: 'poker',
      kind: 'rss',
      is_active: true,
    };
    db.due = [row(1, 0), news];
    const body = await run(() => new Response(atomFeed(1, ['2026-09-19T12:00:00+00:00']), { status: 200 }));
    expect(body).toMatchObject({ sources_scanned: 1, youtube_answered: true, failures_charged: 0, sources_retired: 0 });
    expect(db.updates.filter((u) => u.id === 'src-news')).toEqual([]);
  });
});

describe('positive evidence still retires', () => {
  it('a channel whose newest upload is older than the dormancy limit is retired from a real read', async () => {
    db.due = [row(1, 0)];
    const body = await run(() => new Response(atomFeed(1, ['2024-12-01T00:00:00+00:00']), { status: 200 }));
    expect(body).toMatchObject({ sources_retired: 1, feeds_read: 1 });
    expect(patchFor(1)).toEqual([expect.objectContaining({ is_active: false, consecutive_failures: 0 })]);
  });

  it('a real feed with nothing in it is charged when YouTube is answering', async () => {
    db.due = [row(1, 0), row(2, 2)];
    const body = await run((url) =>
      url.includes(channelId(1))
        ? new Response(atomFeed(1, ['2026-09-19T12:00:00+00:00']), { status: 200 })
        : new Response(atomFeed(2, []), { status: 200 }),
    );
    expect(body).toMatchObject({ failures_charged: 1, sources_retired: 0 });
    expect(patchFor(2)).toEqual([expect.objectContaining({ consecutive_failures: 3, clips_found: 0 })]);
  });
});

describe('the state transition itself', () => {
  const base = { channel_id: channelId(1), consecutive_failures: 4 };
  const now = NOW.getTime();

  it('a non-answer changes nothing but the visit time', () => {
    const { patch, retired } = sourcePatch(base, { kind: 'no-answer', channelId: channelId(1) }, now);
    expect(retired).toBe(false);
    expect(Object.keys(patch).sort()).toEqual(['last_scraped_at', 'updated_at']);
  });

  it('only a real Atom document is a feed', () => {
    expect(isAtomFeed(atomFeed(1, []))).toBe(true);
    expect(isAtomFeed(interstitial)).toBe(false);
  });
});
