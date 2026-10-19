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
const freshness = vi.hoisted(() => ({ screen: vi.fn() }));
vi.mock('./VideoCandidateFreshness.js', () => ({ freshVideoCaptionCandidates: freshness.screen }));

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
  publishVideoClip,
  takeRandomCandidates,
  videoCaptionCandidatePriority,
  type FleetHorse,
} from './HorsePublisher.js';
import { fleetHash, isDueForPost } from './FleetScheduler.js';
import { newsSources, sliceForHorse, type SupplyClip } from './ClipSupply.js';
import {composeCaption} from './Composer.js';
import {briefForAsset} from './PostBrief.js';
import {styleSheetFor} from './StyleSheet.js';

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
  feed.parseURL.mockResolvedValue({ items: [{ title: 'APT Championship offers $8.1 million guaranteed', link: 'https://news.example/a', enclosure: { url: 'https://cdn.news.example/photos/main-event.webp' } }] });
  voice.writeCaption.mockReset();
  freshness.screen.mockReset();
  freshness.screen.mockImplementation(async (clips: SupplyClip[]) => ({ status: 'ok', clips, scanned: clips.length, stale: 0, keys: clips.length }));
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
        modes.video = false;
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

  it('prefers a genuine linked video/Reel over an available illustrated news article', async () => {
    modes.grounded = false;
    const result = await publishForHorse(horse(horseWhereGroundedFirstIs(false)), { slot: SLOT });
    expect(result).toMatchObject({success:true,type:expect.stringMatching(/_video$/),postId:'post-1',reelId:'reel-1'});
    expect(db.rpcCalls.filter(call=>call.name==='publish_horse_news_post')).toHaveLength(0);
    expect(feed.parseURL).not.toHaveBeenCalled();
  });

  it('tries the other category short before a preferred-category broadcast in the mixed publisher',async()=>{
    modes.grounded=false;vi.spyOn(Math,'random').mockReturnValue(.9);
    const make=(id:string,title:string,source:string,duration_seconds:number)=>({id,video_id:id,
      source_url:`https://www.youtube.com/watch?v=${id}`,source,title,category:source==='NBA'?'basketball':'poker',oembed_ok:true,duration_seconds});
    const poker=[make('AAAAAAAAAAA','All in on the river stale','PokerGO',40),make('BBBBBBBBBBB','Final table river call','PokerGO',12000)];
    const sports=[make('CCCCCCCCCCC','LeBron James dunks','NBA',15)];
    const good=await voice.writeCaption.getMockImplementation()!(horse(horseId(0)),{});
    voice.writeCaption.mockImplementation(async (_horse,asset)=>asset.title.includes('stale')?{...good,text:'',stale:true}:good);
    const result=await publishForHorse(horse(horseId(0)),{skipGuard:true,slot:SLOT,sharedVideoSupply:{poker,sports}});
    expect(result).toMatchObject({success:true,type:'sports_video'});
    expect(db.rpcCalls.find(call=>call.name==='publish_horse_video_reel')?.args).toMatchObject({p_topic:'sports',p_video_url:sports[0]!.source_url});
  });

  it('balances categories after real freshness, not a stale low-concentration raw poker row',async()=>{
    modes.grounded=false;
    const make=(id:string,title:string,source:string)=>({id,video_id:id,source_url:`https://www.youtube.com/watch?v=${id}`,
      source,title,category:source==='NBA'?'highlight':'poker',sport_type:source==='NBA'?'nba':null,oembed_ok:true,duration_seconds:30});
    const stale=make('AAAAAAAAAAA','Phil Ivey makes a river call','PokerGO');
    const guarantee=make('BBBBBBBBBBB','Trailblazer Warm-Up $100K GTD','TCH Live');
    const sports=make('CCCCCCCCCCC','Aaron Gordon’s Fancy Handle Finds Cam Johnson for the Open Three','NBA');
    freshness.screen.mockImplementation(async(clips:SupplyClip[])=>({status:'ok',clips:clips.filter(c=>c.video_id!==stale.video_id),
      scanned:clips.length,stale:clips.some(c=>c.video_id===stale.video_id)?1:0,keys:clips.length}));
    const raw={poker:[stale,guarantee],sports:[sports],recent:[{title:'Lone Star Showdown $50K guarantee',source:'TCH Live',topic:'poker'}]};
    const result=await publishForHorse(horse(horseId(0)),{skipGuard:true,slot:SLOT,sharedVideoSupply:raw});
    expect(result).toMatchObject({success:true,type:'sports_video'});
    expect(db.rpcCalls.find(call=>call.name==='publish_horse_video_reel')?.args).toMatchObject({p_topic:'sports',p_video_url:sports.source_url});
    // Each short category is screened once; the winning projection reuses
    // only this same horse's private preflight, never a second ledger scan.
    expect(freshness.screen).toHaveBeenCalledTimes(2);
    expect(raw.poker).toEqual([stale,guarantee]);
    expect(raw.sports).toEqual([sports]);
  });

  it('does not publish an eligible category behind an unknown alternate freshness read',async()=>{
    modes.grounded=false;
    const make=(id:string,source:string,title:string)=>({id,video_id:id,source_url:`https://www.youtube.com/watch?v=${id}`,
      source,title,category:'highlight',oembed_ok:true,duration_seconds:30});
    const poker=[make('AAAAAAAAAAA','PokerGO','Phil Ivey makes a river call')];
    const sports=[make('BBBBBBBBBBB','NBA','Aaron Gordon’s Fancy Handle Finds Cam Johnson for the Open Three')];
    freshness.screen.mockImplementation(async(clips:SupplyClip[],topic:string)=>topic==='sports'?{status:'unknown',error:'shared ledger unknown'}:
      {status:'ok',clips,scanned:clips.length,stale:0,keys:1});
    expect(await publishForHorse(horse(horseId(0)),{skipGuard:true,slot:SLOT,sharedVideoSupply:{poker,sports}}))
      .toMatchObject({success:false,outcome:'unknown',error:'shared ledger unknown'});
    expect(db.rpcCalls).toHaveLength(0);
    expect(voice.writeCaption).not.toHaveBeenCalled();
    expect(feed.parseURL).not.toHaveBeenCalled();
  });

  it.each([{poker:[],sports:[]},undefined])('does not bypass a failed shared preflight through empty tiers or grounded/news fallback (%j)',async sharedVideoSupply=>{
    const result=await publishForHorse(horse(horseWhereGroundedFirstIs(true)),{skipGuard:true,slot:SLOT,
      sharedVideoSupply,sharedVideoSupplyError:'shared registry unavailable'});
    expect(result).toMatchObject({success:false,outcome:'unknown',error:'shared registry unavailable'});
    expect(voice.writeGrounded).not.toHaveBeenCalled();
    expect(voice.writeCaption).not.toHaveBeenCalled();
    expect(feed.parseURL).not.toHaveBeenCalled();
    expect(db.rpcCalls).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
    expect(db.reads).toHaveLength(0);
  });

  it('keeps known short/excerpt candidates ahead of full streams even under hostile random draws', () => {
    vi.spyOn(Math,'random').mockReturnValue(.9999);
    const rows=[{source_url:'https://www.youtube.com/watch?v=AbCdEfGhIjK',duration_seconds:12000}, {source_url:'https://www.youtube.com/watch?v=ShortClip01',duration_seconds:43}, {source_url:'https://www.youtube.com/shorts/ShortClip02',duration_seconds:null}];
    expect(takeRandomCandidates(rows,3).map(row=>row.duration_seconds)).toEqual([43,null,12000]);
  });

  it('prefers literal factual shorts over stale generic shorts without promoting a full stream', () => {
    vi.spyOn(Math,'random').mockReturnValue(.9999);
    const rows = [
      {source_url:'https://www.youtube.com/watch?v=Generic0001',title:'CRAZY FINAL TABLE',source:'PokerGO',duration_seconds:43},
      {source_url:'https://www.youtube.com/watch?v=Factual0001',title:'Navigating a five-way all-in',source:'PokerGO',duration_seconds:73},
      {source_url:'https://www.youtube.com/watch?v=Stream00001',title:'Navigating a five-way all-in',source:'PokerGO',duration_seconds:12000},
    ] as SupplyClip[];
    expect(takeRandomCandidates(rows,3,clip=>videoCaptionCandidatePriority(clip,'poker')).map(x=>x.duration_seconds)).toEqual([73,43,12000]);
  });

  it('widens a generic-only preferred short slice to an unused literal fact within the same six-candidate cap', async () => {
    const profileId=horseId(0);
    const sources=Array.from({length:9},(_,i)=>`Source${i}`);
    const preferred=new Set(sliceForHorse(sources,profileId));
    const factualSource=sources.find(source=>!preferred.has(source))!;
    const clips=sources.map((source,i)=>({
      id:`clip-${i}`,video_id:`Factual000${i}`,source_url:`https://www.youtube.com/watch?v=Factual000${i}`,
      source,title:source===factualSource?'Navigating a five-way all-in':'CRAZY FINAL TABLE',duration_seconds:60,
    })) as SupplyClip[];
    const good=await voice.writeCaption.getMockImplementation()!(horse(profileId),{});
    voice.writeCaption.mockImplementation(async (_horse,asset)=>asset.title.includes('five-way')?good:{...good,text:'',stale:true});
    const result=await publishVideoClip(horse(profileId),'poker',[],'fleet',{poker:clips,sports:[]},`fleet:${profileId}:${SLOT}`);
    expect(result).toMatchObject({success:true,postId:'post-1',reelId:'reel-1'});
    expect(voice.writeCaption).toHaveBeenCalledTimes(1);
    expect(voice.writeCaption.mock.calls[0]?.[1]).toMatchObject({title:'Navigating a five-way all-in'});
    expect(db.rpcCalls.filter(x=>x.name==='publish_horse_video_reel')).toHaveLength(1);
  });

  it('screens past six asset-fresh but meaning-stale factual shorts before choosing the bounded writer candidates', async () => {
    const clips = Array.from({length: 7}, (_,index)=>({id:`clip-${index}`,video_id:`Factual000${index}`,
      source_url:`https://www.youtube.com/watch?v=Factual000${index}`, source:'PokerGO',
      title:index===6?'Pocket aces in a four-way pot':'Navigating a five-way all-in',duration_seconds:60,
    })) as SupplyClip[];
    freshness.screen.mockResolvedValue({status:'ok', clips:[clips[6]], scanned:7, stale:6, keys:2});
    const result=await publishVideoClip(horse(horseId(0)),'poker',[],'fleet',{poker:clips,sports:[]},'fleet:slot');
    expect(result.success).toBe(true);
    expect(freshness.screen.mock.calls[0]?.[0]).toHaveLength(7);
    expect(voice.writeCaption).toHaveBeenCalledTimes(1);
    expect(voice.writeCaption.mock.calls[0]?.[1].title).toBe(clips[6]!.title);
  });

  it('does not publish or fall through on unreadable meaning preflight', async () => {
    freshness.screen.mockResolvedValue({status:'unknown',error:'semantic ledger unavailable'});
    const clip={id:'x',video_id:'Factual0001',source_url:'https://www.youtube.com/watch?v=Factual0001',source:'PokerGO',title:'Navigating a five-way all-in',duration_seconds:60} as SupplyClip;
    const result=await publishVideoClip(horse(horseId(0)),'poker',[],'fleet',{poker:[clip],sports:[]},'fleet:slot');
    expect(result).toMatchObject({success:false,outcome:'unknown'});
    expect(voice.writeCaption).not.toHaveBeenCalled();
    expect(db.rpcCalls.filter(x=>x.name==='publish_horse_video_reel')).toHaveLength(0);
  });

  it('does not publish an article card with missing or generic artwork', async () => {
    modes.grounded=false;modes.video=false;
    feed.parseURL.mockResolvedValue({items:[{title:'APT Championship offers $8.1 million guaranteed',link:'https://news.example/a',enclosure:{url:'https://cdn.example/publisher-logo.png'}}]});
    const result=await publishForHorse(horse(horseWhereGroundedFirstIs(false)),{slot:SLOT});
    expect(result).toMatchObject({success:false,skipped:'content_exhausted'});
    expect(result.error).toContain('genuine associated story artwork');
    expect(db.rpcCalls.filter(call=>call.name==='publish_horse_news_post')).toHaveLength(0);
  });

  it('a clean news publication carries the key and every atomic ledger input', async () => {
    modes.grounded = false;
    modes.video = false;
    const id = horseWhereGroundedFirstIs(false);
    const r = await publishForHorse(horse(id), { slot: SLOT });
    expect(r).toMatchObject({ success: true, postId: 'post-1' });
    expect(r.created).toBe(true);
    // This mock's async limit cannot chain abortSignal: creation is known,
    // but an unreadable post-commit read must remain visibility unknown.
    expect(r.publicationEvidence).toMatchObject({ status: 'unknown', endpointVerified: false });
    expect(db.inserts.filter((x) => x.table === 'social_posts')).toHaveLength(0);
    const call = db.rpcCalls.find((x) => x.name === 'publish_horse_news_post')!;
    expect(call.args).toMatchObject({
      p_publication_key: `fleet:${id}:${SLOT}`,
      p_asset_key: 'url:news.example/a',
      p_phrase_norm: 'called the river with second pair and it held',
      p_semantic_key: 'sem:river-call-second-pair',
      p_link_url: 'https://news.example/a',
      p_link_title: 'APT Championship offers $8.1 million guaranteed',
      p_link_site_name: 'Poker Wire',
    });
    expect(['poker', 'sports']).toContain(call.args.p_news_type);
    expect(ledger.recordPhrase).not.toHaveBeenCalled();
    expect(ledger.recordAssetUse).not.toHaveBeenCalled();
    expect(ledger.recordBrief).not.toHaveBeenCalled();
  });

  it('falls through a configured 429 feed to another registered publisher without a producer retry', async () => {
    modes.grounded=false;modes.video=false;
    vi.mocked(newsSources).mockResolvedValueOnce([
      {id:'a',name:'Throttled',feed_url:'https://blocked.example/rss',fallback_urls:null},
      {id:'b',name:'Healthy',feed_url:'https://healthy.example/rss',fallback_urls:null},
    ]);
    feed.parseURL.mockRejectedValueOnce(new Error('Status code 429')).mockResolvedValueOnce({items:[
      {title:'APT Championship offers $8.1 million guaranteed',link:'https://healthy.example/a',content:'<img src="https://cdn.healthy.example/photos/story.jpg">'},
    ]});
    const result=await publishForHorse(horse(horseWhereGroundedFirstIs(false)),{slot:SLOT});
    expect(result.success).toBe(true);
    expect(feed.parseURL).toHaveBeenCalledTimes(2);
    expect(db.rpcCalls.filter(call=>call.name==='publish_horse_news_post')).toHaveLength(1);
  });

  it('finds genuine inline story art beyond three blank leading articles', async () => {
    modes.grounded=false;modes.video=false;
    feed.parseURL.mockResolvedValue({items:[...Array.from({length:3},(_,index)=>({title:'APT Championship offers $8.1 million guaranteed',link:`https://news.example/blank${index}`})),
      {title:'APT Championship offers $8.1 million guaranteed',link:'https://news.example/illustrated',content:'<img src="https://cdn.news.example/photos/actual-story.jpg">'},
    ]});
    const result=await publishForHorse(horse(horseWhereGroundedFirstIs(false)),{slot:SLOT});
    expect(result.success).toBe(true);
    expect(db.rpcCalls.find(call=>call.name==='publish_horse_news_post')?.args).toMatchObject({
      p_link_url:'https://news.example/illustrated',p_link_image:'https://cdn.news.example/photos/actual-story.jpg',
    });
  });

  it('screens unsupported article facts before spending the three artwork slots', async () => {
    modes.grounded=false;modes.video=false;
    const id=horseWhereGroundedFirstIs(false);
    const items=[...Array.from({length:3},(_,index)=>({title:'Poker strategy chatter without a literal fact',link:`https://news.example/unsupported${index}`,content:`<img src="https://cdn.news.example/photos/unsupported${index}.jpg">`})),
      {title:'APT Championship offers $8.1 million guaranteed',link:'https://news.example/factual-fourth',content:'<img src="https://cdn.news.example/photos/championship.jpg">'}];
    feed.parseURL.mockResolvedValue({items});
    voice.writeCaption.mockImplementation(async (_author:unknown,asset:Parameters<typeof briefForAsset>[0])=>{
      const brief=briefForAsset(asset);
      return {...composeCaption(brief,styleSheetFor(id)),brief,attempts:1,belowFloor:false};
    });
    const result=await publishForHorse(horse(id),{slot:SLOT});
    expect(result.success).toBe(true);
    expect(db.rpcCalls.find(call=>call.name==='publish_horse_news_post')?.args).toMatchObject({p_link_url:'https://news.example/factual-fourth',p_link_image:'https://cdn.news.example/photos/championship.jpg'});
  });

  it('does not try another feed after an unknown atomic-news acknowledgement', async () => {
    modes.grounded=false;modes.video=false;
    db.newsRpcResult={data:null,error:{message:'Connection lost after request'}};
    const result=await publishForHorse(horse(horseWhereGroundedFirstIs(false)),{slot:SLOT});
    expect(result).toMatchObject({success:false,outcome:'unknown'});
    expect(feed.parseURL).toHaveBeenCalledTimes(1);
    expect(db.rpcCalls.filter(call=>call.name==='publish_horse_news_post')).toHaveLength(1);
  });

  it('tries an already-illustrated factual second article after the first caption fails the quality gate', async () => {
    modes.grounded=false;modes.video=false;
    vi.spyOn(Math,'random').mockReturnValue(0);
    feed.parseURL.mockResolvedValue({items:[
      {title:'Adrian Mateos Wins Poker Masters Title',link:'https://news.example/unsupported',content:'<img src="https://cdn.news.example/photos/first.jpg">'},
      {title:'APT Championship offers $8.1 million guaranteed',link:'https://news.example/guarantee',content:'<img src="https://cdn.news.example/photos/second.jpg">'},
    ]});
    const good=await voice.writeCaption.getMockImplementation()!(horse(horseId(0)),{});
    voice.writeCaption.mockResolvedValueOnce({...good,text:'',belowFloor:true}).mockResolvedValueOnce(good);
    const result=await publishForHorse(horse(horseWhereGroundedFirstIs(false)),{slot:SLOT});
    expect(result.success).toBe(true);
    expect(feed.parseURL).toHaveBeenCalledTimes(1);
    expect(voice.writeCaption).toHaveBeenCalledTimes(2);
    expect(voice.writeCaption.mock.calls.map(call=>call[1].title)).toEqual([
      'Adrian Mateos Wins Poker Masters Title','APT Championship offers $8.1 million guaranteed',
    ]);
    expect(voice.writeCaption.mock.calls[0]?.[3].modelAttempt).toBe(voice.writeCaption.mock.calls[1]?.[3].modelAttempt);
    expect(db.rpcCalls.filter(call=>call.name==='publish_horse_news_post')).toHaveLength(1);
    expect(db.rpcCalls.find(call=>call.name==='publish_horse_news_post')?.args.p_link_url).toBe('https://news.example/guarantee');
  });

  it('does not advance to an illustrated second article after an unknown atomic acknowledgement', async () => {
    modes.grounded=false;modes.video=false;
    vi.spyOn(Math,'random').mockReturnValue(0);
    feed.parseURL.mockResolvedValue({items:[
      {title:'Adrian Mateos Wins Poker Masters Title',link:'https://news.example/first',content:'<img src="https://cdn.news.example/photos/first.jpg">'},
      {title:'APT Championship offers $8.1 million guaranteed',link:'https://news.example/second',content:'<img src="https://cdn.news.example/photos/second.jpg">'},
    ]});
    db.newsRpcResult={data:null,error:{message:'Connection lost after request'}};
    const result=await publishForHorse(horse(horseWhereGroundedFirstIs(false)),{slot:SLOT});
    expect(result).toMatchObject({success:false,outcome:'unknown'});
    expect(feed.parseURL).toHaveBeenCalledTimes(1);
    expect(voice.writeCaption).toHaveBeenCalledTimes(1);
    expect(db.rpcCalls.filter(call=>call.name==='publish_horse_news_post')).toHaveLength(1);
  });

  it('a news insert carries the actual safe article image in link_image', async () => {
    modes.grounded = false;
    modes.video = false;
    feed.parseURL.mockResolvedValue({
      items: [{
        title: 'APT Championship offers $8.1 million guaranteed',
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
      p_link_title: 'APT Championship offers $8.1 million guaranteed',
      p_link_image: 'https://cdn.news.example/photos/main-event.webp',
    });
  });

  it('refuses a feed item whose article link is not an ordinary web URL', async () => {
    modes.grounded = false;
    modes.video = false;
    feed.parseURL.mockResolvedValue({
      items: [{ title: 'APT Championship offers $8.1 million guaranteed', link: 'javascript:alert(1)' }],
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
    modes.video = false;
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
