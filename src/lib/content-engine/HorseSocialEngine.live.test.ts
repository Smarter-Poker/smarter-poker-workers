/**
 * The social engines against an in-memory database (2026-09-21 recertification).
 *
 * Every case here drives the real engine functions. What is faked: the
 * Supabase client (testing/fakeSupabase.ts, which keeps PostgREST's 1,000-row
 * cap), the kill switch, who is awake, the activity roll, and the two text
 * writers. The writers are faked because this file is about WHERE and WHEN a
 * horse writes, not what it says; the voice has its own law tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb, type Row } from './testing/fakeSupabase.js';

const state = vi.hoisted(() => ({
  client: null as unknown,
  engine: vi.fn(async () => true),
  online: vi.fn((_id: string, _tz?: string, _now?: Date) => true),
  writeComment: vi.fn(),
  writeReply: vi.fn(),
}));

vi.mock('../supabase.js', () => ({ getSupabase: () => state.client }));
vi.mock('./Fleet.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./Fleet.js')>()),
  engineEnabled: state.engine,
}));
vi.mock('./FleetScheduler.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./FleetScheduler.js')>()),
  isOnlineNow: state.online,
}));
vi.mock('./HorseScheduler.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./HorseScheduler.js')>()),
  getHorseActivityRate: () => 1,
}));
vi.mock('./VoiceWriter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./VoiceWriter.js')>()),
  writeComment: state.writeComment,
  writeReply: state.writeReply,
}));
vi.mock('./HumanVoiceEngine.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./HumanVoiceEngine.js')>()),
  generateDMReply: () => 'good game, see you at the tables',
  seedHorseMemory: () => undefined,
}));

import {
  acceptFriendRequests,
  commentOnPosts,
  likePosts,
  reactToComments,
  replyToComments,
  runSocialInteractions,
  sendFriendRequests,
} from './HorseSocialEngine.js';
import { processDirectMessages, HORSE_DM_REPLIES_ENABLED } from './HorseMessengerEngine.js';

let db: FakeDb;

const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();
const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const pid = (n: number): string => `h-${String(n).padStart(4, '0')}`;

function written(text: string) {
  return {
    text,
    brief: { domain: 'poker', concepts: [], sport: undefined, kind: 'text', title: '', people: [], teams: [], amounts: [] },
    style: {},
    relevance: 0.9,
    grounding: [],
    attempts: 1,
    belowFloor: false,
    stale: false,
    briefWasStored: true,
  };
}

/** `count` horses, in storage order h-0001, h-0002, ... */
function seedRoster(count: number): void {
  const authors: Row[] = [];
  const profiles: Row[] = [];
  for (let i = 1; i <= count; i++) {
    authors.push({
      id: `ca-${String(i).padStart(4, '0')}`,
      name: `Horse ${i}`,
      alias: `horse${i}`,
      profile_id: pid(i),
      avatar_url: `https://img.example/${i}.png`,
      timezone: 'America/New_York',
      is_active: true,
      location: null,
      stakes: null,
      specialty: null,
      personality: {},
    });
    profiles.push({ id: pid(i), username: `horse${i}`, full_name: `Horse ${i}`, is_horse: true });
  }
  db.seed('content_authors', authors);
  db.seed('profiles', profiles);
}

function onlyOnline(...ids: string[]): void {
  const set = new Set(ids);
  state.online.mockImplementation((id: string) => set.has(id));
}

function commentsBy(author: string): Row[] {
  return db.rows('social_comments').filter((c) => c.author_id === author);
}

beforeEach(() => {
  db = new FakeDb();
  state.client = db.client;
  state.engine.mockReset();
  state.engine.mockResolvedValue(true);
  state.online.mockReset();
  state.online.mockReturnValue(true);
  state.writeComment.mockReset();
  state.writeComment.mockImplementation(async () => written('That river call took real nerve.'));
  state.writeReply.mockReset();
  state.writeReply.mockImplementation(async () => written('Fair, the turn sizing is what I would change.'));
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

/** The investigator's thread (p2-voice-c probe/capwindow.ts), on a live post. */
function seedCapWindowThread(horse: string, human: string): void {
  db.seed('social_posts', [{ id: 'post-1', author_id: 'u-author', content: 'Big river spot last night', created_at: hoursAgo(61) }]);
  db.seed('social_comments', [
    { id: 'X', post_id: 'post-1', parent_id: null, author_id: horse, content: 'the sizing is the tell here', created_at: hoursAgo(60) },
    { id: 'Y', post_id: 'post-1', parent_id: 'X', author_id: human, content: 'what sizing would you use?', created_at: hoursAgo(59) },
    { id: 'R1', post_id: 'post-1', parent_id: 'Y', author_id: horse, content: 'depends on the sizing', created_at: hoursAgo(49) },
    { id: 'Z', post_id: 'post-1', parent_id: 'R1', author_id: human, content: 'fair, and on the river?', created_at: hoursAgo(47.5) },
    { id: 'R2', post_id: 'post-1', parent_id: 'Z', author_id: horse, content: 'I think it holds up', created_at: hoursAgo(47) },
    { id: 'W', post_id: 'post-1', parent_id: 'R2', author_id: human, content: 'ok but why?', created_at: hoursAgo(1) },
  ]);
}

describe('P2C-03: reply caps hold across the 48-hour window', () => {
  it('the cap-window thread (X 60h, Y 59h, R1 49h, Z 47.5h, R2 47h, W 1h) ends in horse_turn_cap', async () => {
    seedRoster(1);
    seedCapWindowThread(pid(1), 'u-human');

    const result = await replyToComments(12);

    expect(commentsBy(pid(1))).toHaveLength(3); // X, R1, R2 and nothing new
    expect(state.writeReply).not.toHaveBeenCalled();
    expect(result.replied).toBe(0);
    expect(result.skip_reasons).toMatchObject({ horse_turn_cap: 1 });
  });

  it('counts the turn over the whole thread and records the real reply id in horse_thread_state', async () => {
    seedRoster(1);
    db.seed('social_posts', [{ id: 'post-1', author_id: 'u-author', content: 'Big river spot', created_at: hoursAgo(61) }]);
    db.seed('social_comments', [
      { id: 'X', post_id: 'post-1', parent_id: null, author_id: pid(1), content: 'the sizing is the tell', created_at: hoursAgo(60) },
      { id: 'Y', post_id: 'post-1', parent_id: 'X', author_id: 'u-human', content: 'what sizing?', created_at: hoursAgo(59) },
      { id: 'R1', post_id: 'post-1', parent_id: 'Y', author_id: pid(1), content: 'two thirds', created_at: hoursAgo(49) },
      { id: 'Z', post_id: 'post-1', parent_id: 'R1', author_id: 'u-human', content: 'and on the river?', created_at: hoursAgo(1) },
    ]);

    const result = await replyToComments(12);

    expect(result.replied).toBe(1);
    const reply = commentsBy(pid(1)).find((c) => c.parent_id === 'Z');
    expect(reply).toBeDefined();
    const turns = db.rows('horse_thread_state');
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      post_id: 'post-1',
      horse_id: pid(1),
      comment_id: reply!.id,
      parent_id: 'Z',
      reason: 'human_unanswered',
      turn_index: 2,
    });
  });

  it('a second horse in the same run sees the reply the first horse wrote (thread cap within one run)', async () => {
    seedRoster(3);
    db.seed('social_posts', [{ id: 'post-1', author_id: 'u-author', content: 'Hand review', created_at: hoursAgo(10) }]);
    db.seed('social_comments', [
      { id: 'A', post_id: 'post-1', parent_id: null, author_id: pid(1), content: 'fold pre', created_at: hoursAgo(9) },
      { id: 'B', post_id: 'post-1', parent_id: null, author_id: pid(2), content: 'call is fine', created_at: hoursAgo(9) },
      { id: 'C', post_id: 'post-1', parent_id: null, author_id: pid(3), content: 'three bet', created_at: hoursAgo(9) },
      { id: 'T1', post_id: 'post-1', parent_id: 'C', author_id: pid(1), content: 'too loose?', created_at: hoursAgo(8) },
      { id: 'T2', post_id: 'post-1', parent_id: 'A', author_id: pid(3), content: 'why fold?', created_at: hoursAgo(7) },
      { id: 'H1', post_id: 'post-1', parent_id: 'A', author_id: 'u-1', content: 'nah, you are wrong', created_at: hoursAgo(2) },
      { id: 'H2', post_id: 'post-1', parent_id: 'B', author_id: 'u-2', content: 'why call there?', created_at: hoursAgo(2) },
    ]);

    await replyToComments(12);

    const horseReplies = db.rows('social_comments').filter((c) => String(c.author_id).startsWith('h-') && c.parent_id !== null);
    expect(horseReplies).toHaveLength(3); // MAX_HORSE_TURNS, not four
  });
});

describe('P2C-04: horses only ever write on live content', () => {
  it('never answers a comment that is already deleted', async () => {
    seedRoster(1);
    db.seed('social_posts', [{ id: 'post-1', author_id: 'u-author', content: 'River spot', created_at: hoursAgo(5) }]);
    db.seed('social_comments', [
      { id: 'X', post_id: 'post-1', parent_id: null, author_id: pid(1), content: 'jam it', created_at: hoursAgo(4) },
      { id: 'Y', post_id: 'post-1', parent_id: 'X', author_id: 'u-human', content: 'why jam?', created_at: hoursAgo(2), is_deleted: true },
    ]);

    await replyToComments(12);

    expect(commentsBy(pid(1))).toHaveLength(1);
  });

  it('re-reads the parent comment before writing and skips when it was deleted meanwhile', async () => {
    seedRoster(1);
    db.seed('social_posts', [{ id: 'post-1', author_id: 'u-author', content: 'River spot', created_at: hoursAgo(5) }]);
    db.seed('social_comments', [
      { id: 'X', post_id: 'post-1', parent_id: null, author_id: pid(1), content: 'jam it', created_at: hoursAgo(4) },
      { id: 'Y', post_id: 'post-1', parent_id: 'X', author_id: 'u-human', content: 'why jam?', created_at: hoursAgo(2) },
    ]);
    state.writeReply.mockImplementation(async () => {
      const y = db.rows('social_comments').find((c) => c.id === 'Y');
      if (y) y.is_deleted = true; // deleted while the horse was drafting
      return written('Because the river card changes nothing for him.');
    });

    const result = await replyToComments(12);

    expect(commentsBy(pid(1))).toHaveLength(1);
    expect(result.skip_reasons).toMatchObject({ target_not_live: 1 });
  });

  it('re-reads the post before a reply and skips when it was deleted meanwhile', async () => {
    seedRoster(1);
    db.seed('social_posts', [{ id: 'post-1', author_id: 'u-author', content: 'River spot', created_at: hoursAgo(5) }]);
    db.seed('social_comments', [
      { id: 'X', post_id: 'post-1', parent_id: null, author_id: pid(1), content: 'jam it', created_at: hoursAgo(4) },
      { id: 'Y', post_id: 'post-1', parent_id: 'X', author_id: 'u-human', content: 'why jam?', created_at: hoursAgo(2) },
    ]);
    state.writeReply.mockImplementation(async () => {
      const p = db.rows('social_posts').find((r) => r.id === 'post-1');
      if (p) p.is_deleted = true;
      return written('Because the river card changes nothing for him.');
    });

    const result = await replyToComments(12);

    expect(commentsBy(pid(1))).toHaveLength(1);
    expect(result.skip_reasons).toMatchObject({ post_not_live: 1 });
  });

  it('never comments on a deleted, hidden or flagged post', async () => {
    seedRoster(1);
    db.seed('social_posts', [
      { id: 'gone', author_id: 'u-1', content: 'deleted', created_at: hoursAgo(1), is_deleted: true },
      { id: 'hidden', author_id: 'u-2', content: 'friends only', created_at: hoursAgo(1), visibility: 'friends' },
      { id: 'flagged', author_id: 'u-3', content: 'reported', created_at: hoursAgo(1), is_flagged: true },
    ]);

    await commentOnPosts(20, true);

    expect(commentsBy(pid(1))).toHaveLength(0);
  });

  it('re-reads the post before a comment and skips when it was deleted meanwhile', async () => {
    seedRoster(1);
    db.seed('social_posts', [{ id: 'post-1', author_id: 'u-1', content: 'River spot', created_at: hoursAgo(1) }]);
    state.writeComment.mockImplementation(async () => {
      const p = db.rows('social_posts').find((r) => r.id === 'post-1');
      if (p) p.is_deleted = true;
      return written('That river call took real nerve.');
    });

    const result = await commentOnPosts(20, true);

    expect(commentsBy(pid(1))).toHaveLength(0);
    expect(result.skip_reasons).toMatchObject({ post_not_live: 1 });
  });

  it('reacts only to live horse comments on live posts', async () => {
    seedRoster(2);
    onlyOnline(pid(1));
    db.seed('social_posts', [
      { id: 'live', author_id: 'u-1', content: 'a', created_at: hoursAgo(3) },
      { id: 'gone', author_id: 'u-1', content: 'b', created_at: hoursAgo(3), is_deleted: true },
    ]);
    db.seed('social_comments', [
      { id: 'on-gone-post', post_id: 'gone', author_id: pid(2), content: 'x', created_at: hoursAgo(1) },
      { id: 'deleted', post_id: 'live', author_id: pid(2), content: 'y', created_at: hoursAgo(1), is_deleted: true },
      { id: 'orphan', post_id: 'missing', author_id: pid(2), content: 'z', created_at: hoursAgo(1) },
    ]);

    await reactToComments(15);

    expect(db.rows('social_interactions')).toHaveLength(0);
  });
});

describe('P2C-09: an unreadable cooldown is a cooldown', () => {
  it('skips a comment when the cooldown read fails, and counts it', async () => {
    seedRoster(1);
    db.seed('social_posts', [{ id: 'post-1', author_id: 'u-1', content: 'River spot', created_at: hoursAgo(1) }]);
    db.fail((op) => op.table === 'social_comments' && op.kind === 'select' && op.filters.includes('eq:post_id'));

    const result = await commentOnPosts(20, true);

    expect(commentsBy(pid(1))).toHaveLength(0);
    expect(result.skip_reasons).toMatchObject({ cooldown_unreadable: 1 });
  });

  it('skips a reply when the cooldown read fails, and counts it', async () => {
    seedRoster(1);
    db.seed('social_posts', [{ id: 'post-1', author_id: 'u-author', content: 'River spot', created_at: hoursAgo(5) }]);
    db.seed('social_comments', [
      { id: 'X', post_id: 'post-1', parent_id: null, author_id: pid(1), content: 'jam it', created_at: hoursAgo(4) },
      { id: 'Y', post_id: 'post-1', parent_id: 'X', author_id: 'u-human', content: 'why jam?', created_at: hoursAgo(2) },
    ]);
    db.fail((op) => op.table === 'social_comments' && op.kind === 'select' && op.filters.includes('eq:parent_id'));

    const result = await replyToComments(12);

    expect(commentsBy(pid(1))).toHaveLength(1);
    expect(result.skip_reasons).toMatchObject({ cooldown_unreadable: 1 });
  });

  it('skips a comment when the daily count cannot be read', async () => {
    seedRoster(1);
    db.seed('social_posts', [{ id: 'post-1', author_id: 'u-1', content: 'River spot', created_at: hoursAgo(1) }]);
    db.fail((op) => op.table === 'social_comments' && op.kind === 'select' && op.filters.includes('eq:author_id') && !op.filters.includes('eq:post_id'));

    const result = await commentOnPosts(20, true);

    expect(commentsBy(pid(1))).toHaveLength(0);
    expect(result.skip_reasons).toMatchObject({ daily_limit_unreadable: 1 });
  });
});

describe('A1: a 1,001st horse is never dropped', () => {
  const last = pid(1001);

  beforeEach(() => {
    seedRoster(1001);
    onlyOnline(last);
  });

  it('likes', async () => {
    db.seed('social_posts', [{ id: 'post-1', author_id: 'u-1', content: 'x', created_at: hoursAgo(1) }]);
    await likePosts(40, true);
    expect(db.rows('social_likes').map((l) => l.user_id)).toEqual([last]);
  });

  it('comments', async () => {
    db.seed('social_posts', [{ id: 'post-1', author_id: 'u-1', content: 'x', created_at: hoursAgo(1) }]);
    await commentOnPosts(20, true);
    expect(commentsBy(last)).toHaveLength(1);
  });

  it('replies', async () => {
    db.seed('social_posts', [{ id: 'post-1', author_id: 'u-1', content: 'x', created_at: hoursAgo(5) }]);
    db.seed('social_comments', [
      { id: 'X', post_id: 'post-1', parent_id: null, author_id: last, content: 'jam', created_at: hoursAgo(4) },
      { id: 'Y', post_id: 'post-1', parent_id: 'X', author_id: 'u-human', content: 'why?', created_at: hoursAgo(2) },
    ]);
    await replyToComments(12);
    expect(commentsBy(last).filter((c) => c.parent_id === 'Y')).toHaveLength(1);
  });

  it('reactions', async () => {
    db.seed('social_posts', [{ id: 'post-1', author_id: 'u-1', content: 'x', created_at: hoursAgo(5) }]);
    db.seed('social_comments', [{ id: 'C', post_id: 'post-1', author_id: pid(7), content: 'nice', created_at: hoursAgo(1) }]);
    await reactToComments(20);
    expect(db.rows('social_interactions').map((r) => r.user_id)).toEqual([last]);
  });

  it('friend requests sent', async () => {
    db.seed('profiles', [{ id: 'u-person', username: 'person', full_name: 'A Person', is_horse: false }]);
    await sendFriendRequests(10);
    expect(db.rows('friendships').map((f) => f.user_id)).toEqual([last]);
  });

  it('friend requests accepted', async () => {
    db.seed('friendships', [{ id: 'fr-1', user_id: 'u-person', friend_id: last, status: 'pending', created_at: hoursAgo(3) }]);
    await acceptFriendRequests(15);
    expect(db.rows('friendships').find((f) => f.id === 'fr-1')?.status).toBe('accepted');
  });

  it('direct messages answered', async () => {
    db.seed('social_conversations', [{ id: 'conv-1', user1_id: 'u-person', user2_id: last }]);
    db.seed('social_messages', [{ id: 'm-1', conversation_id: 'conv-1', sender_id: 'u-person', content: 'gg last night', created_at: minutesAgo(5), read_at: null }]);
    await processDirectMessages({ repliesEnabled: true });
    expect(db.rows('social_messages').filter((m) => m.sender_id === last)).toHaveLength(1);
  });
});

describe('A2 and A3: friend requests', () => {
  it('senders are awake horses in random order, not the first rows in storage', async () => {
    seedRoster(40);
    const awake = new Set(Array.from({ length: 20 }, (_, i) => pid(2 * (i + 1)))); // even-numbered horses
    state.online.mockImplementation((id: string) => awake.has(id));
    db.seed('profiles', Array.from({ length: 30 }, (_, i) => ({ id: `u-${i}`, username: `person${i}`, full_name: `Person ${i}`, is_horse: false })));

    await sendFriendRequests(10);

    const senders = db.rows('friendships').map((f) => String(f.user_id));
    expect(senders.length).toBeGreaterThan(0);
    for (const s of senders) expect(awake.has(s)).toBe(true);
    const storageOrderPrefix = Array.from({ length: senders.length }, (_, i) => pid(i + 1));
    expect(senders).not.toEqual(storageOrderPrefix);
  });

  it('never puts the roster into a GET IN list, and still finds people with a full roster', async () => {
    seedRoster(1000);
    onlyOnline(pid(1));
    db.seed('profiles', [{ id: 'u-person', username: 'person', full_name: 'A Person', is_horse: false }]);

    await sendFriendRequests(10);

    const widest = Math.max(0, ...db.log.flatMap((o) => o.inListSizes));
    expect(widest).toBeLessThanOrEqual(100);
    expect(db.rows('friendships').map((f) => f.friend_id)).toEqual(['u-person']);
  });

  it('counts an unreadable real-user list instead of ignoring it', async () => {
    seedRoster(3);
    db.fail((op) => op.table === 'profiles' && op.kind === 'select');

    const result = await sendFriendRequests(10);

    expect(result.skip_reasons).toMatchObject({ real_users_unreadable: 1 });
  });

  it('accepts requests to horses even behind 600 older requests to people', async () => {
    seedRoster(5);
    db.seed('friendships', Array.from({ length: 600 }, (_, i) => ({
      id: `human-req-${i}`, user_id: `u-a${i}`, friend_id: `u-b${i}`, status: 'pending', created_at: hoursAgo(5000 - i),
    })));
    db.seed('friendships', [{ id: 'to-horse', user_id: 'u-person', friend_id: pid(3), status: 'pending', created_at: hoursAgo(10) }]);

    const result = await acceptFriendRequests(15);

    expect(result.accepted).toBe(1);
    expect(db.rows('friendships').find((f) => f.id === 'to-horse')?.status).toBe('accepted');
  });
});

describe('D2: turning the engine off stops a run in flight', () => {
  it('likes stop at the next write once the switch flips', async () => {
    seedRoster(3);
    db.seed('social_posts', [
      { id: 'p1', author_id: 'u-1', content: 'a', created_at: hoursAgo(1) },
      { id: 'p2', author_id: 'u-1', content: 'b', created_at: hoursAgo(2) },
      { id: 'p3', author_id: 'u-1', content: 'c', created_at: hoursAgo(3) },
    ]);
    // entry check, first write check: on; everything after: off
    state.engine.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);

    const result = await likePosts(40, true);

    expect(db.rows('social_likes')).toHaveLength(1);
    expect(result.skip_reasons).toMatchObject({ engine_disabled: 1 });
  });

  it('a comment drafted before the flip is not written after it', async () => {
    seedRoster(1);
    db.seed('social_posts', [{ id: 'post-1', author_id: 'u-1', content: 'x', created_at: hoursAgo(1) }]);
    state.writeComment.mockImplementation(async () => {
      state.engine.mockResolvedValue(false); // switched off while drafting
      return written('That river call took real nerve.');
    });

    await commentOnPosts(20, true);

    expect(commentsBy(pid(1))).toHaveLength(0);
  });

  it('runSocialInteractions starts no step after the switch goes off', async () => {
    seedRoster(2);
    db.seed('social_posts', [{ id: 'post-1', author_id: 'u-1', content: 'x', created_at: hoursAgo(1) }]);
    db.seed('profiles', [{ id: 'u-person', username: 'person', full_name: 'A Person', is_horse: false }]);
    let calls = 0;
    state.engine.mockImplementation(async () => {
      calls += 1;
      return calls <= 3; // enough for the friends step to begin, then off
    });

    const result = await runSocialInteractions();

    expect(db.rows('social_comments')).toHaveLength(0);
    expect(db.rows('social_likes')).toHaveLength(0);
    expect(result.stopped).toBe('engine_disabled');
  });

  it('a direct message is not sent after the flip', async () => {
    seedRoster(1);
    db.seed('social_conversations', [{ id: 'conv-1', user1_id: 'u-person', user2_id: pid(1) }]);
    db.seed('social_messages', [{ id: 'm-1', conversation_id: 'conv-1', sender_id: 'u-person', content: 'gg', created_at: minutesAgo(5), read_at: null }]);
    state.engine.mockResolvedValueOnce(true).mockResolvedValue(false);

    const result = await processDirectMessages({ repliesEnabled: true });

    expect(db.rows('social_messages').filter((m) => m.sender_id === pid(1))).toHaveLength(0);
    expect(result).toMatchObject({ replied: 0, skip_reasons: { engine_disabled: 1 } });
  });
});

describe('direct messages count the whole conversation', () => {
  it('the three-reply cap sees replies after the tenth message', async () => {
    seedRoster(1);
    db.seed('social_conversations', [{ id: 'conv-1', user1_id: 'u-person', user2_id: pid(1) }]);
    const msgs: Row[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push({ id: `m-${String(i).padStart(2, '0')}`, conversation_id: 'conv-1', sender_id: 'u-person', content: `msg ${i}`, created_at: minutesAgo(60 - i), read_at: minutesAgo(1) });
    }
    for (let i = 10; i < 13; i++) {
      msgs.push({ id: `m-${i}`, conversation_id: 'conv-1', sender_id: pid(1), content: `reply ${i}`, created_at: minutesAgo(60 - i), read_at: minutesAgo(1) });
    }
    msgs.push({ id: 'm-99', conversation_id: 'conv-1', sender_id: 'u-person', content: 'still there?', created_at: minutesAgo(2), read_at: null });
    db.seed('social_messages', msgs);

    await processDirectMessages({ repliesEnabled: true });

    expect(db.rows('social_messages').filter((m) => m.sender_id === pid(1))).toHaveLength(3);
  });
});

describe('horse DM replies stay held until the DM product contract is settled', () => {
  it('the scheduled call answers nobody and says why, even with a person waiting', async () => {
    seedRoster(1);
    db.seed('social_conversations', [{ id: 'conv-1', user1_id: 'u-person', user2_id: pid(1) }]);
    db.seed('social_messages', [{ id: 'm-1', conversation_id: 'conv-1', sender_id: 'u-person', content: 'gg last night', created_at: minutesAgo(5), read_at: null }]);

    const result = await processDirectMessages();

    expect(db.rows('social_messages').filter((m) => m.sender_id === pid(1))).toHaveLength(0);
    expect(result).toMatchObject({ replied: 0, skip_reasons: { dm_replies_held: 1 } });
    expect(HORSE_DM_REPLIES_ENABLED).toBe(false);
  });
});

describe('counts on the post are left to the database triggers', () => {
  // trig_update_post_comment_count and trg_sync_like_count already add 1 for
  // every social_comments and social_likes row; the engine used to add a
  // second 1 through increment_post_count, so each horse action counted twice.
  const countCalls = () => db.log.filter((o) => o.table === 'rpc:increment_post_count');
  const countUpdates = () => db.writes('social_posts', 'update');

  beforeEach(() => {
    seedRoster(1);
  });

  it('a horse comment does not bump comment_count itself', async () => {
    db.seed('social_posts', [{ id: 'post-1', author_id: 'u-1', content: 'x', created_at: hoursAgo(1) }]);
    await commentOnPosts(20, true);
    expect(commentsBy(pid(1))).toHaveLength(1);
    expect(countCalls()).toHaveLength(0);
    expect(countUpdates()).toHaveLength(0);
  });

  it('a horse like does not bump like_count itself', async () => {
    db.seed('social_posts', [{ id: 'post-1', author_id: 'u-1', content: 'x', created_at: hoursAgo(1) }]);
    await likePosts(40, true);
    expect(db.rows('social_likes').map((l) => l.user_id)).toEqual([pid(1)]);
    expect(countCalls()).toHaveLength(0);
    expect(countUpdates()).toHaveLength(0);
  });

  it('a horse reply does not bump comment_count itself', async () => {
    db.seed('social_posts', [{ id: 'post-1', author_id: 'u-1', content: 'x', created_at: hoursAgo(5) }]);
    db.seed('social_comments', [
      { id: 'X', post_id: 'post-1', parent_id: null, author_id: pid(1), content: 'jam', created_at: hoursAgo(4) },
      { id: 'Y', post_id: 'post-1', parent_id: 'X', author_id: 'u-human', content: 'why?', created_at: hoursAgo(2) },
    ]);
    await replyToComments(12);
    expect(commentsBy(pid(1)).filter((c) => c.parent_id === 'Y')).toHaveLength(1);
    expect(countCalls()).toHaveLength(0);
    expect(countUpdates()).toHaveLength(0);
  });
});
