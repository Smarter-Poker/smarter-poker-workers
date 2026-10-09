/**
 * P2C-09: the freshness ledger fails CLOSED (2026-09-21).
 *
 * Every ledger read guards something about to be written to the feed. These
 * drive the real ledger functions, and the real comment writer, against an
 * in-memory database whose ledger reads can be made to fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from './testing/fakeSupabase.js';

const state = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('../supabase.js', () => ({ getSupabase: () => state.client }));
vi.mock('./Fleet.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./Fleet.js')>()),
  engineEnabled: async () => true,
}));
vi.mock('./FleetScheduler.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./FleetScheduler.js')>()),
  isOnlineNow: () => true,
}));
vi.mock('./HorseScheduler.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./HorseScheduler.js')>()),
  getHorseActivityRate: () => 1,
}));
// The composer is pinned so the only variable is the ledger.
vi.mock('./Composer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./Composer.js')>()),
  composeComment: () => ({
    text: 'Calling that river with a bluff catcher takes nerve.',
    relevance: 0.9,
    grounding: ['river'],
    semanticKey: 'comment:river-call',
  }),
}));

import * as ledger from './ContentLedger.js';
import { commentOnPosts } from './HorseSocialEngine.js';

let db: FakeDb;
const ledgerDown = () =>
  db.fail((op) => (op.table === 'horse_phrase_ledger' || op.table === 'content_asset_use') && op.kind === 'select');

beforeEach(() => {
  db = new FakeDb();
  state.client = db.client;
  vi.spyOn(Math, 'random').mockReturnValue(0.2);
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn();
    return 0;
  }) as unknown as typeof setTimeout);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ledger reads', () => {
  it('a readable ledger still says unused (control)', async () => {
    expect(await ledger.phraseRecentlyUsed('a fresh line', 'h-1')).toBe(false);
    expect(await ledger.groundedPhraseRecentlyUsed('a fresh grounded line', 'h-1')).toBe(false);
    expect(await ledger.phraseUsedOnPost('a fresh line', 'post-1')).toBe(false);
    expect([...(await ledger.filterUnusedAssets(['yt:aaaaaaaaaaa'], 'h-1'))]).toEqual(['yt:aaaaaaaaaaa']);
  });

  it('phraseRecentlyUsed: unreadable means used', async () => {
    ledgerDown();
    expect(await ledger.phraseRecentlyUsed('a fresh line', 'h-1')).toBe(true);
  });

  it('grounded programme freshness: platform reuse and unreadability both mean used', async () => {
    db.seed('horse_phrase_ledger', [{
      id: 'phrase-1',
      phrase_norm: 'a grounded line',
      horse_id: 'another-horse',
      used_at: '2026-10-01T00:00:00.000Z',
    }]);
    expect(await ledger.groundedPhraseRecentlyUsed('a grounded line', 'h-1')).toBe(true);
    ledgerDown();
    expect(await ledger.groundedPhraseRecentlyUsed('another grounded line', 'h-1')).toBe(true);
  });

  it('phraseUsedOnPost: unreadable means used', async () => {
    ledgerDown();
    expect(await ledger.phraseUsedOnPost('a fresh line', 'post-1')).toBe(true);
  });

  it('filterUnusedAssets: an unreadable chunk is used, none of it is offered', async () => {
    ledgerDown();
    const usable = await ledger.filterUnusedAssets(['yt:aaaaaaaaaaa', 'yt:bbbbbbbbbbb'], 'h-1');
    expect(usable.size).toBe(0);
  });

  it('recentFrameKeys: unreadable abandons the grounded draft instead of claiming nothing was spoken', async () => {
    ledgerDown();
    await expect(ledger.recentFrameKeys('hand', 'cooler')).rejects.toThrow(/ledger_unreadable/);
  });

  it('every failed read is counted', async () => {
    ledger._resetLedgerReadFailures();
    ledgerDown();
    await ledger.phraseRecentlyUsed('x', 'h-1');
    await ledger.phraseUsedOnPost('x', 'p-1');
    await ledger.filterUnusedAssets(['yt:aaaaaaaaaaa'], 'h-1');
    await ledger.recentFrameKeys('hand', 'cooler').catch(() => undefined);
    expect(ledger.ledgerReadFailures()).toEqual({ phrase: 1, post_phrase: 1, asset: 1, frame: 1 });
    expect(ledger.ledgerReadFailureTotal()).toBe(4);
  });
});

describe('a comment through the real writer', () => {
  function seed(): void {
    db.seed('content_authors', [{
      id: 'ca-1', name: 'Horse 1', alias: 'horse1', profile_id: 'h-1', timezone: 'America/New_York',
      is_active: true, location: null, stakes: null, specialty: null, personality: {}, avatar_url: null,
    }]);
    // The roster keeps only profiles that are horses with an avatar (Fleet.loadFleet).
    db.seed('profiles', [{ id: 'h-1', username: 'horse1', full_name: 'Horse 1', is_horse: true, avatar_url: 'https://img.example/1.png' }]);
    db.seed('social_posts', [{ id: 'post-1', author_id: 'u-1', content_type: 'text', content: 'Called off with ace high on the river last night', created_at: new Date().toISOString() }]);
  }

  it('is written when the ledger can be read (control)', async () => {
    seed();
    const result = await commentOnPosts(20, true);
    expect(result.commented).toBe(1);
    expect(db.rows('social_comments')).toHaveLength(1);
  });

  it('is not written when the ledger cannot be read, and the run says why', async () => {
    seed();
    ledgerDown();
    const result = await commentOnPosts(20, true);
    expect(db.rows('social_comments')).toHaveLength(0);
    expect(result.commented).toBe(0);
    expect(result.stale_drafts).toBe(1);
    expect(result.skip_reasons).toMatchObject({ no_text: 1 });
    expect(result.skip_reasons.ledger_unreadable).toBeGreaterThan(0);
  });
});
