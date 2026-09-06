/**
 * The Phase 2 law: horses write about the real thing, in their own voice, and
 * never name a human player.
 *
 * Every pin here is one of Dan's sentences from 2026-09-05, turned into
 * something that fails if it stops being true:
 *
 *   "100+ DIFFERENT WRITING STYLES ... CAN NOT APPEAR SIMILAR OR SAME
 *    FORMATTING"                          -> the style spread suite
 *   "THE WORDS ... NEED TO MAKE SENSE FOR THE ACTUAL THING THE HORSE IS
 *    POSTING ABOUT 100%"                  -> the relevance suite
 *   "A DETERMINISTIC ENGINE THAT CAN REPLY ... NOT AN ENDLESS STREAM"
 *                                         -> the thread suite
 *   "NOT EVERY HORSE SHOULD BE FRIENDS WITH EVERY OTHER HORSE, THAT WOULD BE
 *    WEIRD AND SUSPICIOUS"                -> the friend graph suite
 *
 * Named `*.law.test.ts` per this repo's convention (see
 * src/routes/horses-are-players-in-every-detector.law.test.ts): a law test
 * pins a rule somebody stated, not an implementation detail, so weakening a
 * pin here is a decision that has to be argued rather than a refactor.
 */
import { describe, it, expect } from 'vitest';
import { briefForAsset, briefForPost, topicOf, softenCaps, cleanTitle, isHeadlineCase, isUninformativeTitle } from './PostBrief.js';
import { styleSheetFor, styleId, render, stripBannedGlyphs } from './StyleSheet.js';
import { composeCaption, composeComment, relevanceOf, RELEVANCE_FLOOR } from './Composer.js';
import { areFriends, friendsOf, tagCandidateFor, type FriendCandidate } from './FriendGraph.js';
import { decideReply, MAX_TURNS_PER_HORSE, MAX_HORSE_TURNS, type ThreadComment } from './ReplyEngine.js';
import { fleetHash } from './FleetScheduler.js';

function fleetIds(n = 1000): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const h = fleetHash(String(i), 'law').toString(16).padStart(8, '0');
    const g = fleetHash(String(i), 'law2').toString(16).padStart(8, '0');
    ids.push(`${h}-${g.slice(0, 4)}-4${g.slice(4, 7)}-8${h.slice(1, 4)}-${g}${h.slice(0, 4)}`);
  }
  return ids;
}

const CITIES = ['Chicago, IL', 'Las Vegas, NV', 'London, UK', 'Miami, FL', 'Austin, TX'];
const STAKES = ['1/2', '2/5', '5/10', '10/25'];
const SPECIALTIES = ['cash games', 'tournaments', 'PLO', 'live cash'];

function fleetCandidates(n = 1000): FriendCandidate[] {
  return fleetIds(n).map((id, i) => ({
    profile_id: id,
    alias: `horse${i}`,
    location: CITIES[fleetHash(id, 'city') % CITIES.length]!,
    stakes: STAKES[fleetHash(id, 'stk') % STAKES.length]!,
    specialty: SPECIALTIES[fleetHash(id, 'spec') % SPECIALTIES.length]!,
  }));
}

// Real titles, taken from sports_clips and the poker feeds in production.
const REAL_ASSETS: Array<{ kind: 'video' | 'link'; title: string; source: string }> = [
  { kind: 'video', title: 'Angel holding her own in the paint', source: 'Bleacher Report' },
  { kind: 'video', title: 'THIS IS MAGIC OMG', source: 'House of Highlights' },
  { kind: 'video', title: 'The MSG crowd is like no other', source: 'NBA' },
  { kind: 'video', title: 'No one saw this coming #NBA #Lakers', source: 'Los Angeles Lakers' },
  { kind: 'link', title: "Too Weak to Call, Strong Enough to Raise: Garrett Adelstein's $60K Bluff", source: 'Upswing Poker' },
  { kind: 'link', title: '3 Cash Game Exploits Regs Use, Backed By Data', source: 'Upswing Poker' },
  { kind: 'link', title: 'Phil Ivey Wins 11th WSOP Bracelet', source: 'CardPlayer' },
];

describe('the brief reads the real subject', () => {
  it('pulls a known player out of a headline-cased title without inventing others', () => {
    const b = briefForAsset(REAL_ASSETS[4]!);
    expect(b.people).toContain('Garrett Adelstein');
    // The old extractor produced "Call Strong Enough" and "Too Weak" here.
    expect(b.people.join(' ')).not.toMatch(/Call Strong|Too Weak|Raise Garrett/);
    expect(b.concepts).toContain('bluff');
    expect(b.amounts).toContain('$60K');
    expect(b.domain).toBe('poker');
  });

  it('reads a sentence-cased title the other way, where capitals do mean a name', () => {
    const b = briefForAsset(REAL_ASSETS[0]!);
    expect(b.people).toContain('Angel');
    expect(isHeadlineCase(b.title)).toBe(false);
  });

  it('calms a shouty title and keeps real acronyms', () => {
    expect(softenCaps('THIS IS MAGIC OMG')).toBe('This Is Magic Omg');
    expect(softenCaps('LEBRON DUNKS ON THE NBA FINALS')).toContain('NBA');
  });

  it('keeps apostrophes inside words and drops surrounding quotes', () => {
    expect(cleanTitle(`"Garrett Adelstein's bluff"`)).toBe("Garrett Adelstein's bluff");
  });

  it('takes the meaningful half of a colon headline as the topic', () => {
    expect(topicOf("Too Weak to Call, Strong Enough to Raise: Garrett Adelstein's $60K Bluff"))
      .toBe("Garrett Adelstein's $60K Bluff");
  });

  it('knows a placeholder title when it sees one', () => {
    // Measured 2026-09-05: 3,487 of 8,236 sports_clips titles contain their
    // own channel name. The first Phase 2 fire published "Bleacher Report NBA
    // NBA Clip and nobody in the building blinked" before this existed.
    expect(isUninformativeTitle('Bleacher Report NBA NBA Clip', 'Bleacher Report NBA')).toBe(true);
    expect(isUninformativeTitle('NBA Highlights', 'NBA')).toBe(true);
    expect(isUninformativeTitle('Lakers Clip', 'Lakers')).toBe(true);
    expect(isUninformativeTitle('Angel holding her own in the paint', 'Bleacher Report')).toBe(false);
  });

  it('knows YouTube player furniture is not a clip title', () => {
    // 3,855 of 8,236 sports_clips rows had one of these as their title.
    for (const junk of ['Keyboard shortcuts', 'Playback', 'Subtitles and closed captions', 'Spherical Videos', 'Sign in to YouTube']) {
      expect(isUninformativeTitle(junk, 'NBA')).toBe(true);
      const b = briefForAsset({ kind: 'video', title: junk, source: 'NBA' });
      expect(b.topic).toBeUndefined();
      for (const id of fleetIds(10)) {
        const t = composeCaption(b, styleSheetFor(id)).text.toLowerCase();
        expect(t).not.toContain('keyboard');
        expect(t).not.toContain('spherical');
        expect(t).not.toContain('closed caption');
      }
    }
  });

  it('refuses to quote a placeholder title', () => {
    const b = briefForAsset({ kind: 'video', title: 'Bleacher Report NBA NBA Clip', source: 'Bleacher Report NBA' });
    expect(b.topic).toBeUndefined();
    expect(b.confidence).toBeLessThanOrEqual(0.35);
    for (const id of fleetIds(30)) {
      const t = composeCaption(b, styleSheetFor(id)).text;
      expect(t.toLowerCase()).not.toContain('nba clip');
      expect(t.toLowerCase()).not.toContain('bleacher report');
      expect(t.trim().length).toBeGreaterThan(3);
    }
  });

  it('never claims confidence it does not have', () => {
    const empty = briefForAsset({ kind: 'video', title: '', source: null });
    expect(empty.confidence).toBeLessThan(0.3);
    expect(empty.people).toEqual([]);
  });
});

describe('100+ writing styles, and no two horses look the same', () => {
  const ids = fleetIds();

  it('the fleet spreads across well over 100 distinct style fingerprints', () => {
    const seen = new Set(ids.map((id) => styleId(styleSheetFor(id))));
    expect(seen.size).toBeGreaterThan(100);
  });

  it('no single style holds more than a twentieth of the fleet', () => {
    const counts = new Map<string, number>();
    for (const id of ids) {
      const k = styleId(styleSheetFor(id));
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBeLessThan(ids.length / 20);
  });

  it('every formatting dimension is actually used by somebody', () => {
    const sheets = ids.map(styleSheetFor);
    for (const dim of ['length', 'casing', 'punctuation', 'opener', 'closer', 'layout'] as const) {
      const values = new Set(sheets.map((s) => s[dim]));
      expect(values.size).toBeGreaterThan(1);
    }
    // The visually loudest dimensions must all appear in the wild.
    expect(sheets.some((s) => s.layout === 'list')).toBe(true);
    expect(sheets.some((s) => s.layout === 'double_break')).toBe(true);
    expect(sheets.some((s) => s.casing === 'lower')).toBe(true);
    expect(sheets.some((s) => s.punctuation === 'none')).toBe(true);
  });

  it('one clip through 200 horses gives mostly different sentences', () => {
    const brief = briefForAsset(REAL_ASSETS[0]!);
    const texts = ids.slice(0, 200).map((id) => composeCaption(brief, styleSheetFor(id)).text);
    const unique = new Set(texts);
    // Before Phase 2 one caption was published verbatim by 26 horses.
    expect(unique.size).toBeGreaterThan(texts.length * 0.5);
    const counts = new Map<string, number>();
    for (const t of texts) counts.set(t, (counts.get(t) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThan(12);
  });

  it('a style sheet is stable: same horse, same voice, every call', () => {
    const a = styleSheetFor(ids[7]!);
    const b = styleSheetFor(ids[7]!);
    expect(styleId(a)).toBe(styleId(b));
    expect(a.lexicon).toEqual(b.lexicon);
  });
});

describe('the words are about the actual thing', () => {
  const ids = fleetIds(60);

  it('every real asset composes above the relevance floor for most horses', () => {
    for (const asset of REAL_ASSETS) {
      const brief = briefForAsset(asset);
      const scores = ids.map((id) => composeCaption(brief, styleSheetFor(id)).relevance);
      const good = scores.filter((s) => s >= RELEVANCE_FLOOR).length;
      expect(good / scores.length).toBeGreaterThan(0.85);
    }
  });

  it('a caption about a poker article does not talk about basketball', () => {
    const brief = briefForAsset(REAL_ASSETS[5]!);
    for (const id of ids.slice(0, 25)) {
      const t = composeCaption(brief, styleSheetFor(id)).text.toLowerCase();
      expect(t).not.toMatch(/\b(dunk|rim|buzzer|touchdown|end zone|home run)\b/);
    }
  });

  it('a caption about a basketball clip does not talk about the flop', () => {
    const brief = briefForAsset(REAL_ASSETS[3]!);
    for (const id of ids.slice(0, 25)) {
      const t = composeCaption(brief, styleSheetFor(id)).text.toLowerCase();
      expect(t).not.toMatch(/\b(flop|river card|all in|bluff|bankroll|solver)\b/);
    }
  });

  it('relevance is zero for a sentence with nothing of the subject in it', () => {
    const brief = briefForAsset(REAL_ASSETS[4]!);
    expect(relevanceOf('the weather today is quite mild', brief)).toBe(0);
  });

  it('a comment reads the post it is under', () => {
    const brief = briefForPost({
      postId: 'p1',
      contentType: 'link',
      content: 'worth reading',
      linkTitle: 'Phil Ivey Wins 11th WSOP Bracelet',
      linkSiteName: 'CardPlayer',
      metadata: { news_type: 'poker' },
    });
    expect(brief.people).toContain('Phil Ivey');
    const good = ids.slice(0, 30)
      .map((id) => composeComment(brief, styleSheetFor(id)).relevance)
      .filter((r) => r >= RELEVANCE_FLOOR).length;
    expect(good).toBeGreaterThan(20);
  });
});

describe('house rules hold in everything a horse publishes', () => {
  const ids = fleetIds(120);

  it('no emoji and no em dashes survive rendering', () => {
    for (const asset of REAL_ASSETS) {
      const brief = briefForAsset(asset);
      for (const id of ids.slice(0, 40)) {
        const t = composeCaption(brief, styleSheetFor(id)).text;
        expect(t).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
        expect(t).not.toContain('—');
      }
    }
  });

  it('strips them even when a caller smuggles them in', () => {
    expect(stripBannedGlyphs('nice hand \u{1F525} — really')).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(stripBannedGlyphs('a — b')).not.toContain('—');
  });

  it('never publishes an empty string for a real asset', () => {
    for (const asset of REAL_ASSETS) {
      const brief = briefForAsset(asset);
      for (const id of ids.slice(0, 20)) {
        expect(composeCaption(brief, styleSheetFor(id)).text.trim().length).toBeGreaterThan(3);
      }
    }
  });
});

describe('threads end', () => {
  const post = 'post-1';
  const horse = 'horse-1';
  const now = new Date('2026-09-06T12:00:00Z');
  const t = (mins: number) => new Date(now.getTime() - mins * 60_000).toISOString();

  const root = (over: Partial<ThreadComment> = {}): ThreadComment => ({
    id: 'c-root', post_id: post, parent_id: null, author_id: horse,
    content: 'the sizing is the tell here', created_at: t(60), isHorse: true, ...over,
  });

  it('answers an unanswered human exactly once', () => {
    const thread = [
      root(),
      { id: 'c-h', post_id: post, parent_id: 'c-root', author_id: 'human-1', content: 'disagree, I think it is a value bet', created_at: t(30), isHorse: false },
    ];
    const first = decideReply(horse, 'myalias', thread, now);
    expect(first.reply).toBe(true);
    expect(first.reason).toBe('human_unanswered');

    const after = [...thread, { id: 'c-r', post_id: post, parent_id: 'c-h', author_id: horse, content: 'fair', created_at: t(20), isHorse: true }];
    expect(decideReply(horse, 'myalias', after, now).reply).toBe(false);
  });

  it('ignores another horse that says something with no reason to answer', () => {
    const thread = [
      root(),
      { id: 'c-2', post_id: post, parent_id: 'c-root', author_id: 'horse-2', content: 'nice one', created_at: t(30), isHorse: true },
    ];
    const d = decideReply(horse, 'myalias', thread, now);
    expect(d.reply).toBe(false);
    expect(d.skipped).toBe('no_reason');
  });

  it('answers a horse that addresses it, asks, or disagrees', () => {
    for (const [content, reason] of [
      ['@myalias what did you have there', 'addressed'],
      ['what would you do on the turn?', 'question'],
      ['hard disagree with that read', 'disagreement'],
    ] as const) {
      const thread = [
        root(),
        { id: 'c-x', post_id: post, parent_id: 'c-root', author_id: 'horse-9', content, created_at: t(10), isHorse: true },
      ];
      const d = decideReply(horse, 'myalias', thread, now);
      expect(d.reply).toBe(true);
      expect(d.reason).toBe(reason);
    }
  });

  it('stops at the per-horse ceiling', () => {
    const thread: ThreadComment[] = [root()];
    for (let i = 0; i < MAX_TURNS_PER_HORSE; i++) {
      thread.push({ id: `in-${i}`, post_id: post, parent_id: 'c-root', author_id: 'horse-2', content: 'why?', created_at: t(40 - i), isHorse: true });
      thread.push({ id: `out-${i}`, post_id: post, parent_id: `in-${i}`, author_id: horse, content: 'because', created_at: t(39 - i), isHorse: true });
    }
    thread.push({ id: 'in-last', post_id: post, parent_id: 'c-root', author_id: 'horse-2', content: 'but why?', created_at: t(5), isHorse: true });
    const d = decideReply(horse, 'myalias', thread, now);
    expect(d.reply).toBe(false);
    expect(d.skipped).toBe('horse_turn_cap');
  });

  it('stops at the thread ceiling however many horses are involved', () => {
    const thread: ThreadComment[] = [root()];
    for (let i = 0; i < MAX_HORSE_TURNS; i++) {
      thread.push({ id: `t-${i}`, post_id: post, parent_id: 'c-root', author_id: `horse-${i + 5}`, content: 'why?', created_at: t(30 - i), isHorse: true });
    }
    expect(decideReply(horse, 'myalias', thread, now).skipped).toBe('thread_turn_cap');
  });

  it('does not resurrect an old thread', () => {
    const thread = [
      root({ created_at: new Date(now.getTime() - 10 * 86_400_000).toISOString() }),
      { id: 'c-old', post_id: post, parent_id: 'c-root', author_id: 'human-2', content: 'thoughts?', created_at: new Date(now.getTime() - 9 * 86_400_000).toISOString(), isHorse: false },
    ];
    expect(decideReply(horse, 'myalias', thread, now).skipped).toBe('thread_too_old');
  });

  it('a two-horse exchange cannot run forever', () => {
    // Simulate them talking until the engine refuses, and assert it refuses.
    const thread: ThreadComment[] = [root()];
    let turns = 0;
    for (let i = 0; i < 20; i++) {
      const d = decideReply(horse, 'myalias', thread, now);
      if (!d.reply) break;
      turns++;
      thread.push({ id: `r-${i}`, post_id: post, parent_id: d.target!.id, author_id: horse, content: 'fair point', created_at: t(20 - i), isHorse: true });
      thread.push({ id: `q-${i}`, post_id: post, parent_id: `r-${i}`, author_id: 'horse-2', content: 'but why though?', created_at: t(19 - i), isHorse: true });
    }
    expect(turns).toBeLessThanOrEqual(MAX_TURNS_PER_HORSE);
  });
});

describe('the friend graph is sparse, symmetric and clustered', () => {
  const fleet = fleetCandidates();

  it('is symmetric', () => {
    for (let i = 0; i < 200; i++) {
      const a = fleet[fleetHash(String(i), 'a') % fleet.length]!;
      const b = fleet[fleetHash(String(i), 'b') % fleet.length]!;
      expect(areFriends(a, b)).toBe(areFriends(b, a));
    }
  });

  it('nobody is friends with themselves', () => {
    for (const h of fleet.slice(0, 50)) expect(areFriends(h, h)).toBe(false);
  });

  it('degree lands in a plausible band, nowhere near the whole fleet', () => {
    const degrees = fleet.slice(0, 120).map((h) => friendsOf(h, fleet).length);
    const avg = degrees.reduce((a, b) => a + b, 0) / degrees.length;
    expect(avg).toBeGreaterThan(6);
    expect(avg).toBeLessThan(45);
    // The tell Dan named: everybody knowing everybody.
    expect(Math.max(...degrees)).toBeLessThan(fleet.length * 0.1);
  });

  it('same-city horses are friends far more often than strangers', () => {
    let sameCityPairs = 0, sameCityFriends = 0, otherPairs = 0, otherFriends = 0;
    for (let i = 0; i < 300; i++) {
      const a = fleet[i]!;
      const b = fleet[(i * 7 + 13) % fleet.length]!;
      if (a.profile_id === b.profile_id) continue;
      const same = a.location === b.location;
      if (same) { sameCityPairs++; if (areFriends(a, b)) sameCityFriends++; }
      else { otherPairs++; if (areFriends(a, b)) otherFriends++; }
    }
    const sameRate = sameCityFriends / Math.max(1, sameCityPairs);
    const otherRate = otherFriends / Math.max(1, otherPairs);
    expect(sameRate).toBeGreaterThan(otherRate);
  });

  it('a tag needs a reason, and is always a horse alias', () => {
    const me = fleet[3]!;
    const cand = tagCandidateFor(me, fleet, { domain: 'poker', concepts: ['cash_game'] }, 'seed');
    if (cand) {
      expect(cand.reason).toBeTruthy();
      expect(cand.friend.profile_id).not.toBe(me.profile_id);
      expect(areFriends(me, cand.friend)).toBe(true);
      expect(cand.friend.alias).toMatch(/^horse\d+$/);
    }
  });
});

describe('a horse never names a human player', () => {
  it('composed text contains no @handle except a tagged horse friend', () => {
    // The Composer itself must never emit an @mention; tagging is the only
    // path that may, and VoiceWriter only ever passes it a horse alias.
    const ids = fleetIds(80);
    for (const asset of REAL_ASSETS) {
      const brief = briefForAsset(asset);
      for (const id of ids) {
        expect(composeCaption(brief, styleSheetFor(id)).text).not.toMatch(/@\w/);
        expect(composeComment(brief, styleSheetFor(id)).text).not.toMatch(/@\w/);
      }
    }
  });

  it('a human name in a post body is never echoed into a comment', () => {
    // A human's post mentioning their own name must not come back out.
    const brief = briefForPost({
      postId: 'p9',
      contentType: 'text',
      content: 'Dan Bekavac just took down the Sunday night tournament at the club',
      metadata: null,
    });
    const ids = fleetIds(40);
    for (const id of ids) {
      const t = composeComment(brief, styleSheetFor(id)).text;
      expect(t).not.toMatch(/Bekavac/i);
    }
  });
});
