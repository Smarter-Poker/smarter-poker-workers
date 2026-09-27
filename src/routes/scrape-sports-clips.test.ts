import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  existing: [] as Array<{ source_url: string; title: string | null }>,
  inserted: [] as Array<Record<string, unknown>>,
  updated: [] as Array<{ source_url: string; patch: Record<string, unknown> }>,
}));

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table !== 'sports_clips') throw new Error(`unexpected table ${table}`);
      const state: {
        op: 'read' | 'insert' | 'update';
        patch?: Record<string, unknown>;
        sourceUrl?: string;
      } = { op: 'read' };
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.in = (column: string, values: string[]) => {
        if (column !== 'source_url') throw new Error(`unexpected in filter ${column}`);
        db.existing = db.existing.filter((row) => values.includes(row.source_url));
        return chain;
      };
      chain.insert = (row: Record<string, unknown>) => {
        state.op = 'insert';
        db.inserted.push(row);
        return chain;
      };
      chain.update = (patch: Record<string, unknown>) => {
        state.op = 'update';
        state.patch = patch;
        return chain;
      };
      chain.eq = (column: string, value: string) => {
        if (column !== 'source_url') throw new Error(`unexpected filter ${column}`);
        state.sourceUrl = value;
        if (state.patch) {
          db.updated.push({ source_url: value, patch: state.patch });
          return Promise.resolve({ error: null });
        }
        return chain;
      };
      chain.maybeSingle = () => Promise.resolve({ data: { id: 'saved' }, error: null });
      chain.then = (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(
        state.op === 'read'
          ? { data: db.existing, error: null }
          : { data: null, error: null },
      ).then(resolve, reject);
      return chain;
    },
  }),
}));

import {
  capClipsRoundRobin,
  createOEmbedFallbackState,
  parseYouTubeShortsPage,
  saveClips,
  scrapeChannelShorts,
  scrapeSportsClips,
  type Clip,
  type SportsChannel,
} from './scrape-sports-clips.js';

const VIDEO_A = 'AAAAAAAAAAA';
const VIDEO_B = 'BBBBBBBBBBB';
const originalFetch = globalThis.fetch;

function currentShortsPage(): string {
  return `<html><script>var ytInitialData = ${JSON.stringify({
    contents: [
      {
        richItemRenderer: {
          content: {
            shortsLockupViewModel: {
              onTap: {
                innertubeCommand: {
                  commandMetadata: { webCommandMetadata: { url: `/shorts/${VIDEO_A}` } },
                  reelWatchEndpoint: { videoId: VIDEO_A },
                },
              },
              overlayMetadata: { primaryText: { content: 'Curry beats the buzzer from half court' } },
            },
          },
        },
      },
      { title: { runs: [{ text: 'Keyboard shortcuts' }] } },
      {
        richItemRenderer: {
          content: {
            shortsLockupViewModel: {
              onTap: {
                innertubeCommand: {
                  commandMetadata: { webCommandMetadata: { url: `/shorts/${VIDEO_B}` } },
                  reelWatchEndpoint: { videoId: VIDEO_B },
                },
              },
              overlayMetadata: { primaryText: { content: 'Mahomes finds Kelce for the touchdown' } },
            },
          },
        },
      },
    ],
  })};</script></html>`;
}

function legacyShortsPage(): string {
  return `<script>ytInitialData = ${JSON.stringify({
    shelf: [
      {
        reelItemRenderer: {
          videoId: VIDEO_A,
          headline: { simpleText: 'Ohtani launches a walk off home run' },
          navigationEndpoint: {
            commandMetadata: { webCommandMetadata: { url: `/shorts/${VIDEO_A}` } },
          },
        },
      },
      {
        reelItemRenderer: {
          navigationEndpoint: { reelWatchEndpoint: { videoId: VIDEO_B } },
          headline: { runs: [{ text: 'Messi curls the free kick into the top corner' }] },
        },
      },
    ],
  })};</script>`;
}

const channel: SportsChannel = {
  name: 'SportsCenter',
  handle: '@SportsCenter',
  sport: 'general',
  category: 'highlight',
};

function clip(videoId: string, title: string): Clip {
  return {
    video_id: videoId,
    source_url: `https://www.youtube.com/shorts/${videoId}`,
    title,
    source: channel.name,
    sport_type: channel.sport,
    category: channel.category,
    channel_handle: channel.handle,
  };
}

function context(query: Record<string, string> = {}) {
  let body: Record<string, unknown> = {};
  return {
    req: { query: (key: string) => query[key] },
    json: (value: Record<string, unknown>) => {
      body = value;
      return value;
    },
    get body() {
      return body;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  db.existing = [];
  db.inserted = [];
  db.updated = [];
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

describe('sports Shorts metadata integrity', () => {
  it('parses both current and legacy renderer shapes without reading unrelated titles', () => {
    expect(parseYouTubeShortsPage(currentShortsPage())).toEqual([
      { videoId: VIDEO_A, title: 'Curry beats the buzzer from half court' },
      { videoId: VIDEO_B, title: 'Mahomes finds Kelce for the touchdown' },
    ]);
    expect(parseYouTubeShortsPage(legacyShortsPage())).toEqual([
      { videoId: VIDEO_A, title: 'Ohtani launches a walk off home run' },
      { videoId: VIDEO_B, title: 'Messi curls the free kick into the top corner' },
    ]);
    expect(parseYouTubeShortsPage(
      '<script>ytInitialData = {"broken":</script><a href="/shorts/CCCCCCCCCCC">Keyboard shortcuts</a>',
    )).toEqual([]);
  });

  it('binds each structured Shorts renderer to its own title and ignores player-menu titles', async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/shorts')) return new Response(currentShortsPage(), { status: 200 });
      throw new Error(`unexpected fallback request ${url}`);
    }) as unknown as typeof fetch;

    const c = context();
    const pending = scrapeSportsClips(c as never);
    await vi.runAllTimersAsync();
    await pending;

    expect(db.inserted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        video_id: VIDEO_A,
        title: 'Curry beats the buzzer from half court',
      }),
      expect.objectContaining({
        video_id: VIDEO_B,
        title: 'Mahomes finds Kelce for the touchdown',
      }),
    ]));
    expect(db.inserted.some((row) => row.title === 'Keyboard shortcuts')).toBe(false);
    expect(db.inserted.some((row) => String(row.title).endsWith(' Clip'))).toBe(false);
  });

  it('supports a production-safe dry run that exercises parsing without database writes', async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      if (String(input).includes('/shorts')) return new Response(currentShortsPage(), { status: 200 });
      throw new Error(`unexpected fallback request ${String(input)}`);
    }) as unknown as typeof fetch;

    const c = context({ dry_run: '1' });
    const pending = scrapeSportsClips(c as never);
    await vi.runAllTimersAsync();
    await pending;

    expect(c.body).toMatchObject({
      success: true,
      dry_run: true,
      channels_scraped: 38,
      channels_with_clips: 38,
      found: 2,
      saved: 0,
      repaired: 0,
    });
    expect(db.inserted).toEqual([]);
    expect(db.updated).toEqual([]);
  });

  it('stagger-starts the full curated scan without serializing slow channel responses', async () => {
    const startedAt: number[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      if (!String(input).includes('/shorts')) throw new Error(`unexpected fallback request ${String(input)}`);
      startedAt.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return new Response(currentShortsPage(), { status: 200 });
    }) as unknown as typeof fetch;

    const c = context({ dry_run: '1' });
    const pending = scrapeSportsClips(c as never);
    await vi.runAllTimersAsync();
    await pending;

    expect(startedAt).toHaveLength(38);
    expect(startedAt.at(-1)! - startedAt[0]!).toBe(37 * 1_500);
    expect(c.body).toMatchObject({
      success: true,
      dry_run: true,
      channels_scraped: 38,
      channels_with_clips: 38,
      found: 2,
    });
  });

  it('uses bounded oEmbed metadata only when a renderer title is unusable', async () => {
    const page = `<script>var ytInitialData = ${JSON.stringify({
      items: [VIDEO_A, VIDEO_B].map((videoId) => ({
        shortsLockupViewModel: {
          onTap: { innertubeCommand: { reelWatchEndpoint: { videoId } } },
          overlayMetadata: { primaryText: { content: 'Keyboard shortcuts' } },
        },
      })),
    })};</script>`;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/shorts')) return new Response(page, { status: 200 });
      const id = new URL(url).searchParams.get('url')?.slice(-11);
      return new Response(JSON.stringify({
        provider_name: 'YouTube',
        type: 'video',
        title: id === VIDEO_A
          ? 'Clark drains the game winner at the buzzer'
          : 'Allen escapes the pocket and finds the end zone',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const state = createOEmbedFallbackState(1);
    const result = await scrapeChannelShorts(channel, state);

    expect(state).toMatchObject({ remaining: 0, attempted: 1, resolved: 1 });
    expect(result.clips).toEqual([
      expect.objectContaining({
        video_id: VIDEO_A,
        title: 'Clark drains the game winner at the buzzer',
        source: 'SportsCenter',
        sport_type: 'general',
        category: 'highlight',
        channel_handle: '@SportsCenter',
      }),
    ]);
    expect(result.rejectedMissingTitle).toBe(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('never fabricates a title when structured metadata and oEmbed cannot establish one', async () => {
    const page = `<script>var ytInitialData = ${JSON.stringify({
      shortsLockupViewModel: {
        onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: VIDEO_A } } },
        overlayMetadata: { primaryText: { content: 'Playback' } },
      },
    })};</script>`;
    globalThis.fetch = vi.fn(async (input: unknown) => String(input).includes('/shorts')
      ? new Response(page, { status: 200 })
      : new Response('gone', { status: 404 })) as unknown as typeof fetch;

    const result = await scrapeChannelShorts(channel, createOEmbedFallbackState(20));

    expect(result).toEqual({ clips: [], rejectedMissingTitle: 1 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('self-heals an existing placeholder title but leaves an existing real title untouched', async () => {
    db.existing = [
      { source_url: `https://www.youtube.com/shorts/${VIDEO_A}`, title: 'Keyboard shortcuts' },
      { source_url: `https://www.youtube.com/shorts/${VIDEO_B}`, title: 'Messi curls the free kick into the top corner' },
    ];

    const result = await saveClips([
      clip(VIDEO_A, 'Ohtani launches a walk off home run'),
      clip(VIDEO_B, 'A different but still descriptive title'),
    ]);

    expect(result).toEqual({ saved: 0, skipped: 1, repaired: 1, failed: 0 });
    expect(db.updated).toEqual([{
      source_url: `https://www.youtube.com/shorts/${VIDEO_A}`,
      patch: { title: 'Ohtani launches a walk off home run' },
    }]);
    expect(db.inserted).toEqual([]);
  });

  it('round-robins the full curated set so late sports survive the 100-clip cap', () => {
    const sports = [
      ...Array(10).fill('nba'),
      ...Array(10).fill('nfl'),
      ...Array(5).fill('mlb'),
      ...Array(5).fill('nhl'),
      ...Array(5).fill('soccer'),
      ...Array(3).fill('general'),
    ];
    const groups = sports.map((sport, channelIndex) => Array.from({ length: 10 }, (_, position) => ({
      ...clip(
        `${String(channelIndex).padStart(3, '0')}${String(position).padStart(8, '0')}`,
        `${sport} athlete scores a remarkable game winner`,
      ),
      source: `Channel ${channelIndex}`,
      sport_type: sport,
    })));

    const selected = capClipsRoundRobin(groups, 100);
    const bySport = new Map<string, number>();
    for (const item of selected) bySport.set(item.sport_type, (bySport.get(item.sport_type) ?? 0) + 1);

    expect(selected).toHaveLength(100);
    expect([...bySport.keys()]).toEqual(['nba', 'nfl', 'mlb', 'nhl', 'soccer', 'general']);
    expect(bySport.get('soccer')).toBeGreaterThanOrEqual(10);
    expect(bySport.get('general')).toBeGreaterThanOrEqual(6);
    expect(selected.some((item) => item.source === 'Channel 37')).toBe(true);
  });
});
