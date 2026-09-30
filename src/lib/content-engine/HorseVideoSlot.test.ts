/**
 * One post per horse per scheduler slot across BOTH video producers
 * (2026-09-29).
 *
 * The isolated horse-video-reels publisher (publishVideoForHorse) used to
 * write through publish_horse_video_reel without a slot key, while the fleet
 * route wrote metadata.publication_key = 'fleet:<profile id>:<slot>'. With
 * the fleet engine on, a due horse could get one video from the isolated
 * route and another post from the fleet route in the same slot. Now:
 *
 *   - the isolated write carries fleetPublicationKey(profile, fleetSlotId(...))
 *     in p_metadata, which the RPC merges into social_posts.metadata under
 *     the unique index uq_social_posts_metadata_publication_key;
 *   - the key is the one the fleet route builds for the same horse at the
 *     same time, so whichever producer inserts second gets 23505;
 *   - 23505 on that index is a duplicate of the slot: a skip, no ledger
 *     rows, no error; the RPC's own 23505 (asset already used) is not;
 *   - a horse with no open slot writes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  guard: { data: [] as unknown[] | null, error: null as { message: string } | null },
  rpcResult: {
    data: [{ social_post_id: 'post-1', social_reel_id: 'reel-1', created: true }] as unknown[] | null,
    error: null as { code?: string; message: string } | null,
  },
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  reads: [] as string[],
}));
const ledger = vi.hoisted(() => ({ recordPhrase: vi.fn(), recordAssetUse: vi.fn(), recordBrief: vi.fn() }));

vi.mock('../supabase.js', () => ({
  getSupabase: () => ({
    // The isolated path writes through the atomic RPC only.
    async rpc(name: string, args: Record<string, unknown>) {
      db.rpcCalls.push({ name, args });
      if (name === 'publish_horse_video_reel') return db.rpcResult;
      return { data: null, error: null };
    },
    from(table: string) {
      db.reads.push(table);
      const state = { guard: false };
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
        limit: async () => {
          if (table === 'social_posts' && state.guard) return { data: db.guard.data, error: db.guard.error };
          return { data: [], error: null };
        },
        maybeSingle: async () => ({ data: null, error: null }),
      });
      return chain;
    },
  }),
}));
vi.mock('./Fleet.js', () => ({ postModeEnabled: vi.fn(async () => true) }));
vi.mock('./HumanVoiceEngine.js', () => ({ seedHorseMemory: vi.fn() }));
vi.mock('./VoiceWriter.js', () => ({
  writeCaption: vi.fn(async () => ({
    text: 'Called the river with second pair and it held',
    stale: false,
    semanticKey: 'sem:river-call-second-pair',
    brief: { kind: 'video' },
    relevance: 0.8,
    grounding: ['title'],
    attempts: 1,
    belowFloor: false,
  })),
  writeGrounded: vi.fn(),
  summarise: () => 'brief',
  recordBrief: ledger.recordBrief,
}));
vi.mock('./ContentLedger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ContentLedger.js')>()),
  filterUnusedAssets: vi.fn(async (keys: string[]) => new Set(keys)),
  recordAssetUse: ledger.recordAssetUse,
  recordPhrase: ledger.recordPhrase,
}));

import {
  fleetPublicationKey,
  fleetSlotId,
  publishVideoForHorse,
  type FleetHorse,
  type SharedHorseVideoSupply,
} from './HorsePublisher.js';
import { isDueForPost } from './FleetScheduler.js';

const NOW = new Date('2026-09-21T14:30:00Z');
const SLOT = '2026-09-21T14';
const SLOT_INDEX_23505 = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "uq_social_posts_metadata_publication_key"',
};
const horseId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const horse = (profileId: string): FleetHorse => ({
  id: 1,
  name: 'RiverRat',
  alias: 'riverrat',
  profile_id: profileId,
  timezone: 'UTC',
});
const supply = (): SharedHorseVideoSupply => ({
  poker: [{
    id: 'clip-a',
    video_id: 'AbCdEfGhIjK',
    source_url: 'https://www.youtube.com/watch?v=AbCdEfGhIjK',
    source: 'Poker source',
    title: 'All in on the river',
    category: 'poker',
    oembed_ok: null,
  }],
  sports: [{
    id: 'clip-b',
    video_id: 'LmNoPqRsTuV',
    source_url: 'https://www.youtube.com/watch?v=LmNoPqRsTuV',
    source: 'Sports source',
    title: 'Buzzer beater game winner',
    category: 'basketball',
    oembed_ok: null,
  }],
});
function firstOpening(profileId: string, timezone: string, from: Date): Date {
  for (let h = 0; h < 24 * 14; h++) {
    const t = new Date(from.getTime() + h * 3_600_000);
    const due = isDueForPost(profileId, timezone, t);
    if (due.due && due.age === 0) return t;
  }
  throw new Error('no posting window in two weeks');
}
const publishRpcs = () => db.rpcCalls.filter((x) => x.name === 'publish_horse_video_reel');
const keyOf = (call: { args: Record<string, unknown> }) =>
  (call.args.p_metadata as Record<string, unknown>).publication_key;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db.guard = { data: [], error: null };
  db.rpcResult = {
    data: [{ social_post_id: 'post-1', social_reel_id: 'reel-1', created: true }],
    error: null,
  };
  db.rpcCalls.length = 0;
  db.reads.length = 0;
  ledger.recordPhrase.mockClear();
  ledger.recordAssetUse.mockClear();
  ledger.recordBrief.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the isolated video producer names the same slot as the fleet', () => {
  it('the write carries the fleet slot key in p_metadata, never as an RPC argument', async () => {
    const id = horseId(3);
    const r = await publishVideoForHorse(horse(id), {
      now: NOW,
      allowedTypes: ['poker'],
      sharedSupply: supply(),
      slot: SLOT,
    });
    expect(r).toMatchObject({ success: true, postId: 'post-1', reelId: 'reel-1', type: 'poker_video' });
    const rpcs = publishRpcs();
    expect(rpcs).toHaveLength(1);
    const args = rpcs[0]!.args;
    const metadata = args.p_metadata as Record<string, unknown>;
    // The RPC merges p_metadata into social_posts.metadata, where the unique
    // index on metadata->>'publication_key' reads it.
    expect(metadata.publication_key).toBe(fleetPublicationKey(id, SLOT));
    expect(metadata.publication_key).toBe(`fleet:${id}:${SLOT}`);
    expect(metadata.scheduler).toBe('horse-video-reels');
    // The reserved social_posts.publication_key column is never set.
    expect(Object.keys(args)).not.toContain('publication_key');
    expect(ledger.recordBrief).toHaveBeenCalledWith('post-1', expect.anything());
  });

  it('without a slot from the caller, the key names the window the horse is due in, as the fleet route would', async () => {
    const id = horseId(7);
    const opened = firstOpening(id, 'UTC', new Date('2026-09-21T00:05:00Z'));
    const lateInWindow = new Date(opened.getTime() + 2 * 3_600_000 + 50 * 60_000);
    const fleetKey = fleetPublicationKey(id, fleetSlotId(id, 'UTC', opened)!);

    const r = await publishVideoForHorse(horse(id), {
      now: lateInWindow,
      allowedTypes: ['poker'],
      sharedSupply: supply(),
    });
    expect(r.success).toBe(true);
    expect(publishRpcs()).toHaveLength(1);
    expect(keyOf(publishRpcs()[0]!)).toBe(fleetKey);
    expect(keyOf(publishRpcs()[0]!)).toBe(fleetPublicationKey(id, fleetSlotId(id, 'UTC', lateInWindow)!));
  });

  it('with no open slot, nothing is read or written', async () => {
    const id = horseId(11);
    let quiet = NOW;
    while (isDueForPost(id, 'UTC', quiet).due) quiet = new Date(quiet.getTime() + 3_600_000);
    const r = await publishVideoForHorse(horse(id), {
      now: quiet,
      allowedTypes: ['poker'],
      sharedSupply: supply(),
    });
    expect(r).toMatchObject({ success: false, skipped: 'no_slot' });
    expect(db.reads).toHaveLength(0);
    expect(db.rpcCalls).toHaveLength(0);
    expect(ledger.recordBrief).not.toHaveBeenCalled();
  });
});

describe('a second insert for the same slot is a duplicate, not a failure', () => {
  it('23505 on the publication-key index: counted as duplicate_slot, one write, no ledger rows, no error', async () => {
    db.rpcResult = { data: null, error: SLOT_INDEX_23505 };
    const id = horseId(3);
    const r = await publishVideoForHorse(horse(id), {
      now: NOW,
      allowedTypes: ['poker', 'sports'],
      sharedSupply: supply(),
      slot: SLOT,
    });
    expect(r).toMatchObject({ success: false, skipped: 'duplicate_slot', publicationKey: `fleet:${id}:${SLOT}` });
    expect(r.error).toBeUndefined();
    expect(r.outcome).toBeUndefined();
    // The skip ends the attempt: the other topic would collide on the same key.
    expect(publishRpcs()).toHaveLength(1);
    expect(ledger.recordBrief).not.toHaveBeenCalled();
    expect(ledger.recordPhrase).not.toHaveBeenCalled();
    expect(ledger.recordAssetUse).not.toHaveBeenCalled();
  });

  it('the database code decides, not the English wording, when the message names the slot index', async () => {
    db.rpcResult = {
      data: null,
      error: {
        code: '23505',
        message: `Key ((metadata ->> 'publication_key'::text))=(fleet:${horseId(3)}:${SLOT}) already exists.`,
      },
    };
    const r = await publishVideoForHorse(horse(horseId(3)), {
      now: NOW,
      allowedTypes: ['poker'],
      sharedSupply: supply(),
      slot: SLOT,
    });
    expect(r).toMatchObject({ success: false, skipped: 'duplicate_slot' });
    expect(r.error).toBeUndefined();
    expect(ledger.recordBrief).not.toHaveBeenCalled();
  });

  it("the RPC's own 23505 (asset already used) is a failure, not a duplicate slot", async () => {
    db.rpcResult = { data: null, error: { code: '23505', message: 'horse has already used this video asset' } };
    const r = await publishVideoForHorse(horse(horseId(3)), {
      now: NOW,
      allowedTypes: ['poker'],
      sharedSupply: supply(),
      slot: SLOT,
    });
    expect(r.success).toBe(false);
    expect(r.skipped).toBeUndefined();
    expect(r.error).toMatch(/horse has already used this video asset/);
    expect(ledger.recordBrief).not.toHaveBeenCalled();
  });

  it('a definite rejection under another code stays a failure even when it mentions the key', async () => {
    db.rpcResult = {
      data: null,
      error: {
        code: '23514',
        message: 'new row for relation "social_posts" violates check constraint "social_posts_publication_key_reserved"',
      },
    };
    const r = await publishVideoForHorse(horse(horseId(3)), {
      now: NOW,
      allowedTypes: ['poker'],
      sharedSupply: supply(),
      slot: SLOT,
    });
    expect(r.success).toBe(false);
    expect(r.skipped).toBeUndefined();
    expect(r.error).toMatch(/social_posts_publication_key_reserved/);
  });

  it('a horse that posted inside the guard window is still skipped as posted_recently, carrying its key', async () => {
    db.guard.data = [{ id: 'earlier' }];
    const id = horseId(3);
    const r = await publishVideoForHorse(horse(id), {
      now: NOW,
      allowedTypes: ['poker'],
      sharedSupply: supply(),
      slot: SLOT,
    });
    expect(r).toMatchObject({ success: false, skipped: 'posted_recently', publicationKey: `fleet:${id}:${SLOT}` });
    expect(db.rpcCalls).toHaveLength(0);
  });
});
