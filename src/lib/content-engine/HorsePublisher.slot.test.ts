/**
 * Recertification F1 and F2 (2026-09-21): the fleet publisher's duplicate
 * protection lives in database state, and its recent-post guard fails closed.
 *
 *   - every post kind (grounded text, news link, video) carries
 *     metadata.publication_key = 'fleet:<profile id>:<slot>'; the video kind
 *     writes through the publish_horse_video_reel RPC, which merges
 *     p_metadata into the row, so the key travels in p_metadata;
 *   - the slot is FleetScheduler's, so overlapping runs build the same key;
 *   - 23505 on that key is a duplicate, not a failure, and writes no ledger;
 *   - an unreadable guard skips the horse instead of publishing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  guard: { data: [] as unknown[] | null, error: null as { message: string } | null, throws: false },
  insertResult: {
    data: { id: 'post-1' } as { id: string } | null,
    error: null as { code?: string; message: string } | null,
  },
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  reads: [] as string[],
  rpcResult: {
    data: [{ social_post_id: 'post-1', social_reel_id: 'reel-1', created: true }] as unknown[] | null,
    error: null as { code?: string; message: string } | null,
  },
  newsRpcResult: {
    data: [{ social_post_id: 'post-1', created: true, reason: null }] as unknown[] | null,
    error: null as { code?: string; message: string } | null,
  },
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));
const ledger = vi.hoisted(() => ({ recordPhrase: vi.fn(), recordAssetUse: vi.fn(), recordBrief: vi.fn() }));
const modes = vi.hoisted(() => ({ grounded: true, video: true }));
const feed = vi.hoisted(() => ({ parseURL: vi.fn() }));
const voice = vi.hoisted(() => ({ writeCaption: vi.fn(), writeGrounded: vi.fn() }));

vi.mock('../supabase.js', () => ({
  getSupabase: () => ({
    // The video kind writes through the atomic RPC; the verdict registry is
    // the other RPC the fleet path reaches. Both answer from here.
    async rpc(name: string, args: Record<string, unknown>) {
      db.rpcCalls.push({ name, args });
      if (name === 'publish_horse_video_reel') return db.rpcResult;
      if (name === 'publish_horse_news_post') return db.newsRpcResult;
      if (name === 'record_youtube_embed_failure_verdict') {
        return {
          data: [{ video_id: args.p_video_id, verification_status: 'resolved', resolved: true }],
          error: null,
        };
      }
      return { data: null, error: null };
    },
    from(table: string) {
      db.reads.push(table);
      const state = { op: 'select', guard: false };
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self,
        eq: self,
        in: self,
        not: self,
        order: self,
        gte: () => {
          state.guard = true;
          return chain;
        },
        update: () => {
          state.op = 'update';
          return chain;
        },
        insert: (row: Record<string, unknown>) => {
          state.op = 'insert';
          db.inserts.push({ table, row });
          return chain;
        },
        limit: async () => {
          if (table === 'social_posts' && state.guard) {
            if (db.guard.throws) throw new Error('socket hang up');
            return { data: db.guard.data, error: db.guard.error };
          }
          return { data: [], error: null };
        },
        maybeSingle: async () => (state.op === 'insert' ? db.insertResult : { data: null, error: null }),
      });
      return chain;
    },
  }),
}));
vi.mock('rss-parser', () => ({ default: class { parseURL = feed.parseURL; } }));
vi.mock('./Fleet.js', () => ({
  postModeEnabled: vi.fn(async (mode: string) => (mode.endsWith('_video') ? modes.video : modes.grounded)),
}));
vi.mock('./YouTubeMetadataVerifier.js', () => ({
  verifyYouTubeMetadata: vi.fn(async () => ({ verdict: 'verified', reason: 'verified' })),
}));
vi.mock('./HumanVoiceEngine.js', () => ({ seedHorseMemory: vi.fn() }));
vi.mock('./VoiceWriter.js', () => ({
  writeCaption: voice.writeCaption,
  writeGrounded: voice.writeGrounded,
  summarise: () => 'brief',
  recordBrief: ledger.recordBrief,
}));
vi.mock('./ContentLedger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ContentLedger.js')>()),
  filterUnusedAssets: vi.fn(async (keys: string[]) => new Set(keys)),
  recordAssetUse: ledger.recordAssetUse,
  recordPhrase: ledger.recordPhrase,
}));
vi.mock('./ClipSupply.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ClipSupply.js')>()),
  newsSources: vi.fn(async () => [{ name: 'Poker Wire', feed_url: 'https://news.example/rss' }]),
  candidateClips: vi.fn(async () => ({
    clips: [{ id: 'clip-1', source_url: 'https://www.youtube.com/watch?v=AbCdEfGhIjK', title: 'Final table river call' }],
    widened: false,
  })),
  recordValidity: vi.fn(),
}));

import {
  _resetFeedCache,
  _resetValidityCache,
  fleetPublicationKey,
  fleetSlotId,
  postedRecently,
  publishForHorse,
  type FleetHorse,
} from './HorsePublisher.js';
import { fleetHash, isDueForPost } from './FleetScheduler.js';

const NOW = new Date('2026-09-21T14:30:00Z');
const SLOT = '2026-09-21T14';
const horseId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const horse = (profileId: string): FleetHorse => ({
  id: 1,
  name: 'RiverRat',
  alias: 'riverrat',
  profile_id: profileId,
  timezone: 'UTC',
});
/** A horse whose day starts with (or without) its own grounded post. */
function horseWhereGroundedFirstIs(wanted: boolean): string {
  for (let i = 0; i < 1000; i++) {
    const id = horseId(i);
    const first = fleetHash(`${id}:${NOW.toISOString().slice(0, 10)}`, 'grounded') % 100 < 60;
    if (first === wanted) return id;
  }
  throw new Error('no such horse');
}
function firstOpening(profileId: string, timezone: string, from: Date): Date {
  for (let h = 0; h < 24 * 14; h++) {
    const t = new Date(from.getTime() + h * 3_600_000);
    const due = isDueForPost(profileId, timezone, t);
    if (due.due && due.age === 0) return t;
  }
  throw new Error('no posting window in two weeks');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db.guard = { data: [], error: null, throws: false };
  db.insertResult = { data: { id: 'post-1' }, error: null };
  db.inserts.length = 0;
  db.reads.length = 0;
  db.rpcResult = {
    data: [{ social_post_id: 'post-1', social_reel_id: 'reel-1', created: true }],
    error: null,
  };
  db.newsRpcResult = {
    data: [{ social_post_id: 'post-1', created: true, reason: null }],
    error: null,
  };
  db.rpcCalls.length = 0;
  modes.grounded = true;
  modes.video = true;
  ledger.recordPhrase.mockClear();
  ledger.recordAssetUse.mockClear();
  ledger.recordBrief.mockClear();
  feed.parseURL.mockReset();
  feed.parseURL.mockResolvedValue({ items: [{ title: 'Deep run at the Main Event', link: 'https://news.example/a' }] });
  voice.writeCaption.mockReset();
  voice.writeCaption.mockResolvedValue({
    text: 'Called the river with second pair and it held',
    stale: false,
    semanticKey: 'sem:river-call-second-pair',
    brief: { kind: 'link' },
    relevance: 0.8,
    grounding: ['title'],
    attempts: 1,
    belowFloor: false,
  });
  voice.writeGrounded.mockReset();
  voice.writeGrounded.mockResolvedValue({
    text: "Folded the turn last night and I still think it's right",
    groundedKind: 'hand',
    grounding: ['hand'],
    brief: { kind: 'hand' },
    relevance: 1,
    attempts: 1,
    frameKey: 'frame:test',
  });
  _resetFeedCache();
  _resetValidityCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ html: '<iframe src="x"></iframe>', title: 'Final table river call' }), { status: 200 }),
    ),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the slot key names the schedule, not the clock', () => {
  it('every run inside one window builds the same key; the next window builds another', () => {
    const id = horseId(7);
    const t0 = firstOpening(id, 'UTC', new Date('2026-09-21T00:05:00Z'));
    const k0 = fleetSlotId(id, 'UTC', t0);
    expect(k0).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/);
    for (const later of [55 * 60_000, 3_600_000, 2 * 3_600_000 + 50 * 60_000]) {
      expect(fleetSlotId(id, 'UTC', new Date(t0.getTime() + later))).toBe(k0);
    }
    expect(fleetSlotId(id, 'UTC', new Date(t0.getTime() + 3 * 3_600_000))).not.toBe(k0);
    const t1 = firstOpening(id, 'UTC', new Date(t0.getTime() + 3 * 3_600_000));
    const k1 = fleetSlotId(id, 'UTC', t1);
    expect(k1).not.toBeNull();
    expect(k1).not.toBe(k0);
    expect(fleetPublicationKey(id, k0!)).toBe(`fleet:${id}:${k0}`);
    expect(fleetPublicationKey(id, k0!)).not.toBe(fleetPublicationKey(id, k1!));
    expect(fleetPublicationKey(id, k0!)).not.toBe(fleetPublicationKey(horseId(8), k0!));
  });

  it('is null when the horse has no open window', () => {
    const id = horseId(7);
    const t0 = firstOpening(id, 'UTC', new Date('2026-09-21T00:05:00Z'));
    expect(fleetSlotId(id, 'UTC', new Date(t0.getTime() - 3_600_000))).toBeNull();
  });

  it('a window that opens at 23:00 keeps its own date after midnight', () => {
    for (let i = 0; i < 2000; i++) {
      const id = horseId(i);
      for (let d = 0; d < 7; d++) {
        const t = new Date(Date.UTC(2026, 8, 21 + d, 23, 20));
        const due = isDueForPost(id, 'UTC', t);
        if (!due.due || due.dueHour !== 23) continue;
        const key = `${t.toISOString().slice(0, 10)}T23`;
        expect(fleetSlotId(id, 'UTC', t)).toBe(key);
        expect(fleetSlotId(id, 'UTC', new Date(t.getTime() + 3_600_000))).toBe(key);
        expect(fleetSlotId(id, 'UTC', new Date(t.getTime() + 2 * 3_600_000))).toBe(key);
        return;
      }
    }
    throw new Error('no horse opens a window at 23:00');
  });

  it('the night after a 23-hour DST day still names the right day', () => {
    // 2027-03-14 is the US spring-forward Sunday. At 00:20 EDT on the 15th,
    // "24 hours ago" is still the 13th; the slot opened on the 14th.
    const after = new Date('2027-03-15T04:20:00Z');
    const before = new Date('2027-03-15T03:20:00Z');
    for (let i = 0; i < 5000; i++) {
      const id = horseId(i);
      const due = isDueForPost(id, 'America/New_York', after);
      if (!due.due || due.dueHour !== 23) continue;
      expect(fleetSlotId(id, 'America/New_York', after)).toBe('2027-03-14T23');
      expect(fleetSlotId(id, 'America/New_York', before)).toBe('2027-03-14T23');
      return;
    }
    throw new Error('no horse opens a window at 23:00 that Sunday');
  });
});

describe('the recent-post guard fails closed', () => {
  it('a guard read error skips the horse and publishes nothing', async () => {
    db.guard.error = { message: 'connection terminated' };
    const r = await publishForHorse(horse(horseId(3)), { slot: SLOT });
    expect(r).toMatchObject({ success: false, skipped: 'guard_unreadable' });
    expect(db.inserts).toHaveLength(0);
    expect(await postedRecently(horseId(3))).toBe(true);
  });

  it('a guard read that throws is unreadable too', async () => {
    db.guard.throws = true;
    const r = await publishForHorse(horse(horseId(3)), { slot: SLOT });
    expect(r).toMatchObject({ success: false, skipped: 'guard_unreadable' });
    expect(db.inserts).toHaveLength(0);
    expect(await postedRecently(horseId(3))).toBe(true);
  });

  it('a horse that posted inside the window is still skipped as posted_recently', async () => {
    db.guard.data = [{ id: 'earlier' }];
    const r = await publishForHorse(horse(horseId(3)), { slot: SLOT });
    expect(r).toMatchObject({ success: false, skipped: 'posted_recently' });
    expect(db.inserts).toHaveLength(0);
  });
});

describe('a second insert for the same slot is a duplicate, not a failure', () => {
  const duplicate = { code: '23505', message: 'duplicate key value violates unique constraint "uq_social_posts_metadata_publication_key"' };
  const cases = [
    {
      kind: 'grounded text',
      id: () => horseWhereGroundedFirstIs(true),
      setup: () => undefined,
      contentType: 'text',
    },
    {
      kind: 'news link',
      id: () => horseWhereGroundedFirstIs(false),
      setup: () => {
        modes.grounded = false;
      },
      contentType: 'link',
    },
    {
      kind: 'video',
      id: () => horseWhereGroundedFirstIs(false),
      setup: () => {
        modes.grounded = false;
        feed.parseURL.mockRejectedValue(new Error('Status code 503'));
        vi.spyOn(Math, 'random').mockReturnValue(0.999);
      },
      contentType: 'video',
    },
  ];

  for (const c of cases) {
    it(`${c.kind}: counted as duplicate_slot, one write, no ledger rows`, async () => {
      c.setup();
      db.insertResult = { data: null, error: duplicate };
      db.rpcResult = { data: null, error: duplicate };
      db.newsRpcResult = {
        data: [{ social_post_id: null, created: false, reason: 'duplicate_slot' }],
        error: null,
      };
      const id = c.id();
      const r = await publishForHorse(horse(id), { slot: SLOT });
      expect(r).toMatchObject({ success: false, skipped: 'duplicate_slot', publicationKey: `fleet:${id}:${SLOT}` });
      expect(r.error).toBeUndefined();
      const posts = db.inserts.filter((x) => x.table === 'social_posts');
      const rpcs = db.rpcCalls.filter((x) => x.name === 'publish_horse_video_reel');
      if (c.contentType === 'video') {
        // The video write is the atomic RPC; the key travels in p_metadata,
        // which the RPC merges into social_posts.metadata under the index.
        expect(posts).toHaveLength(0);
        expect(rpcs).toHaveLength(1);
        const args = rpcs[0]!.args;
        expect((args.p_metadata as Record<string, unknown>).publication_key).toBe(`fleet:${id}:${SLOT}`);
        expect(Object.keys(args)).not.toContain('publication_key');
      } else if (c.contentType === 'link') {
        const newsRpcs = db.rpcCalls.filter((x) => x.name === 'publish_horse_news_post');
        expect(rpcs).toHaveLength(0);
        expect(posts).toHaveLength(0);
        expect(newsRpcs).toHaveLength(1);
        expect(newsRpcs[0]!.args.p_publication_key).toBe(`fleet:${id}:${SLOT}`);
      } else {
        expect(rpcs).toHaveLength(0);
        expect(posts).toHaveLength(1);
        const row = posts[0]!.row;
        expect(row.content_type).toBe(c.contentType);
        expect((row.metadata as Record<string, unknown>).publication_key).toBe(`fleet:${id}:${SLOT}`);
        // The column is reserved for the video library by a CHECK constraint.
        expect(Object.prototype.hasOwnProperty.call(row, 'publication_key')).toBe(false);
        // Phase 8: a news link states its topic; the database derives the rest.
        if (c.contentType === 'link') expect(row).toMatchObject({ topic: 'poker', topics: ['poker', 'news'] });
      }
      expect(ledger.recordPhrase).not.toHaveBeenCalled();
      expect(ledger.recordAssetUse).not.toHaveBeenCalled();
      expect(ledger.recordBrief).not.toHaveBeenCalled();
    });
  }

  it("video: the RPC's own 23505 (asset already used) is a failure, not a duplicate slot", async () => {
    modes.grounded = false;
    feed.parseURL.mockRejectedValue(new Error('Status code 503'));
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    db.rpcResult = { data: null, error: { code: '23505', message: 'horse has already used this video asset' } };
    const id = horseWhereGroundedFirstIs(false);
    const r = await publishForHorse(horse(id), { slot: SLOT });
    expect(r.success).toBe(false);
    expect(r.skipped).toBeUndefined();
    expect(r.error).toMatch(/horse has already used this video asset/);
    expect(ledger.recordBrief).not.toHaveBeenCalled();
  });

  it('a clean video write carries the key in p_metadata and returns the linked pair', async () => {
    modes.grounded = false;
    feed.parseURL.mockRejectedValue(new Error('Status code 503'));
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const id = horseWhereGroundedFirstIs(false);
    const r = await publishForHorse(horse(id), { slot: SLOT });
    expect(r).toMatchObject({ success: true, postId: 'post-1', reelId: 'reel-1', type: 'poker_video' });
    const rpcs = db.rpcCalls.filter((x) => x.name === 'publish_horse_video_reel');
    expect(rpcs).toHaveLength(1);
    const args = rpcs[0]!.args;
    expect((args.p_metadata as Record<string, unknown>).publication_key).toBe(`fleet:${id}:${SLOT}`);
    expect((args.p_metadata as Record<string, unknown>).scheduler).toBe('fleet');
    expect(Object.keys(args)).not.toContain('publication_key');
    expect(db.inserts.filter((x) => x.table === 'social_posts')).toHaveLength(0);
    expect(ledger.recordBrief).toHaveBeenCalledWith('post-1', expect.anything());
  });

  it('a clean news publication carries the key and every atomic ledger input', async () => {
    modes.grounded = false;
    const id = horseWhereGroundedFirstIs(false);
    const r = await publishForHorse(horse(id), { slot: SLOT });
    expect(r).toMatchObject({ success: true, postId: 'post-1' });
    expect(db.inserts.filter((x) => x.table === 'social_posts')).toHaveLength(0);
    const call = db.rpcCalls.find((x) => x.name === 'publish_horse_news_post')!;
    expect(call.args).toMatchObject({
      p_publication_key: `fleet:${id}:${SLOT}`,
      p_asset_key: 'url:news.example/a',
      p_phrase_norm: 'called the river with second pair and it held',
      p_semantic_key: 'sem:river-call-second-pair',
      p_link_url: 'https://news.example/a',
      p_link_title: 'Deep run at the Main Event',
      p_link_site_name: 'Poker Wire',
    });
    expect(['poker', 'sports']).toContain(call.args.p_news_type);
    expect(ledger.recordPhrase).not.toHaveBeenCalled();
    expect(ledger.recordAssetUse).not.toHaveBeenCalled();
    expect(ledger.recordBrief).not.toHaveBeenCalled();
  });

  it('a news insert carries the actual safe article image in link_image', async () => {
    modes.grounded = false;
    feed.parseURL.mockResolvedValue({
      items: [{
        title: 'Deep run at the Main Event',
        link: 'https://news.example/a',
        enclosure: { url: 'https://cdn.news.example/photos/main-event.webp' },
      }],
    });
    const id = horseWhereGroundedFirstIs(false);

    const result = await publishForHorse(horse(id), { slot: SLOT });

    expect(result.success).toBe(true);
    expect(result.type).toMatch(/^(poker|sports)_news$/);
    expect(db.rpcCalls.find((x) => x.name === 'publish_horse_news_post')!.args).toMatchObject({
      p_link_url: 'https://news.example/a',
      p_link_title: 'Deep run at the Main Event',
      p_link_image: 'https://cdn.news.example/photos/main-event.webp',
    });
  });

  it('refuses a feed item whose article link is not an ordinary web URL', async () => {
    modes.grounded = false;
    modes.video = false;
    feed.parseURL.mockResolvedValue({
      items: [{ title: 'Deep run at the Main Event', link: 'javascript:alert(1)' }],
    });
    const id = horseWhereGroundedFirstIs(false);

    const result = await publishForHorse(horse(id), { slot: SLOT });

    expect(result).toMatchObject({ success: false, skipped: 'content_exhausted' });
    expect(result.error).toContain('No articles');
    expect(db.rpcCalls.filter((x) => x.name === 'publish_horse_news_post')).toHaveLength(0);
  });

  it.each([
    ['asset_used', 'Article became used'],
    ['phrase_used', 'Caption became used'],
  ] as const)('classifies an atomic %s race as safe silence', async (reason, detail) => {
    modes.grounded = false;
    modes.video = false;
    db.newsRpcResult = { data: [{ social_post_id: null, created: false, reason }], error: null };
    const id = horseWhereGroundedFirstIs(false);

    const result = await publishForHorse(horse(id), { slot: SLOT });

    expect(result).toMatchObject({ success: false, skipped: 'content_exhausted' });
    expect(result.error).toContain(detail);
    expect(db.inserts.filter((x) => x.table === 'social_posts')).toHaveLength(0);
    expect(ledger.recordPhrase).not.toHaveBeenCalled();
    expect(ledger.recordAssetUse).not.toHaveBeenCalled();
  });

  it('treats an idempotent atomic retry as an existing slot, not a new post', async () => {
    modes.grounded = false;
    modes.video = false;
    db.newsRpcResult = {
      data: [{ social_post_id: 'existing-post', created: false, reason: 'already_published' }],
      error: null,
    };
    const id = horseWhereGroundedFirstIs(false);

    const result = await publishForHorse(horse(id), { slot: SLOT });

    expect(result).toMatchObject({ success: false, skipped: 'duplicate_slot' });
    expect(db.rpcCalls.filter((x) => x.name === 'publish_horse_news_post')).toHaveLength(1);
    expect(db.inserts.filter((x) => x.table === 'social_posts')).toHaveLength(0);
  });

  it('preserves the transaction-side 20-hour guard as safe posted-recently silence', async () => {
    modes.grounded = false;
    modes.video = false;
    db.newsRpcResult = {
      data: [{ social_post_id: null, created: false, reason: 'posted_recently' }],
      error: null,
    };
    const id = horseWhereGroundedFirstIs(false);

    const result = await publishForHorse(horse(id), { slot: SLOT });

    expect(result).toMatchObject({ success: false, skipped: 'posted_recently' });
    expect(db.rpcCalls.filter((x) => x.name === 'publish_horse_news_post')).toHaveLength(1);
    expect(db.inserts.filter((x) => x.table === 'social_posts')).toHaveLength(0);
  });

  it('stops all fallbacks when the atomic news acknowledgement is unknown', async () => {
    modes.grounded = true;
    modes.video = true;
    db.newsRpcResult = { data: null, error: { message: 'socket hang up' } };
    const id = horseWhereGroundedFirstIs(false);

    const result = await publishForHorse(horse(id), { slot: SLOT });

    expect(result).toMatchObject({ success: false, outcome: 'unknown' });
    expect(result.error).toMatch(/atomic horse news publication outcome unknown/);
    expect(db.rpcCalls.filter((x) => x.name === 'publish_horse_news_post')).toHaveLength(1);
    expect(db.rpcCalls.filter((x) => x.name === 'publish_horse_video_reel')).toHaveLength(0);
    expect(db.inserts.filter((x) => x.table === 'social_posts')).toHaveLength(0);
    expect(voice.writeGrounded).not.toHaveBeenCalled();
  });

  it('with no slot given and no window open, nothing is read or written', async () => {
    const id = horseId(11);
    let quiet = NOW;
    while (isDueForPost(id, 'UTC', quiet).due) quiet = new Date(quiet.getTime() + 3_600_000);
    vi.setSystemTime(quiet);
    const r = await publishForHorse(horse(id));
    expect(r).toMatchObject({ success: false, skipped: 'no_slot' });
    expect(db.reads).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });
});

describe('definitive bounded content exhaustion', () => {
  it('treats intentionally disabled grounded modes as safe exhaustion after media exhausts', async () => {
    modes.grounded = false;
    feed.parseURL.mockResolvedValue({ items: [] });
    voice.writeCaption.mockResolvedValue({
      text: '', semanticKey: 'caption:stale', stale: true, brief: {}, relevance: 1,
      grounding: ['title'], attempts: 6, belowFloor: false,
    });
    const id = horseWhereGroundedFirstIs(false);

    const result = await publishForHorse(horse(id), { skipGuard: true, slot: SLOT });

    expect(result).toMatchObject({
      success: false,
      skipped: 'content_exhausted',
      publicationKey: `fleet:${id}:${SLOT}`,
      error: expect.stringContaining('grounded modes await approval'),
    });
    expect(result.error).toContain('No fresh caption cleared the quality gate');
    expect(db.inserts).toHaveLength(0);
  });

  it('tries every approved fallback, then returns one observable safe-silence result', async () => {
    feed.parseURL.mockResolvedValue({ items: [] });
    voice.writeGrounded.mockResolvedValue(null);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })));
    const id = horseWhereGroundedFirstIs(false);

    const result = await publishForHorse(horse(id), { skipGuard: true, slot: SLOT });

    expect(result).toMatchObject({
      success: false,
      skipped: 'content_exhausted',
      publicationKey: `fleet:${id}:${SLOT}`,
      error: expect.stringContaining('No approved grounded story worth telling'),
    });
    expect(result.error).toContain('No articles');
    expect(result.error).toContain('No valid poker clips found after 1 bounded candidates');
    expect(result.error).toContain('All sports clips already posted');
    expect(db.inserts).toHaveLength(0);
  });
});
