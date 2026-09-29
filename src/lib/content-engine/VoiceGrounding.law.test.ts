/**
 * Voice recertification law (2026-09-21, voice-fix): what the p2-voice-c
 * zero-write harness found on real production titles, pinned so it cannot
 * come back. Every example below is a real clip title or a real published
 * failure from that harness (evidence: agents/p2-voice-c/audit.out).
 *
 * Behavioural on purpose: the writers run for real against an in-memory
 * Supabase stub, so a test fails when the published words would be wrong,
 * not when a source line changes shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
const db: { tables: Record<string, Row[]>; failReads: Set<string> } = { tables: {}, failReads: new Set() };

function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: 'select' | 'insert' | 'upsert' = 'select';
  let payload: unknown = null;
  let single = false;
  let limitN: number | null = null;
  let range: [number, number] | null = null;
  const b: Record<string, unknown> = {};
  const self = () => b;
  Object.assign(b, {
    select: self,
    order: self,
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
    gte: (c: string, v: unknown) => { filters.push((r) => String(r[c]) >= String(v)); return b; },
    limit: (n: number) => { limitN = n; return b; },
    range: (from: number, to: number) => { range = [from, to]; return b; },
    maybeSingle: () => { single = true; return b; },
    insert: (p: unknown) => { op = 'insert'; payload = p; return b; },
    upsert: (p: unknown) => { op = 'upsert'; payload = p; return b; },
    then: (resolve: (v: unknown) => void) => {
      const t = (db.tables[table] ??= []);
      if (op === 'select') {
        if (db.failReads.has(table)) return resolve({ data: null, error: { message: `${table} unavailable` } });
        let rows = t.filter((r) => filters.every((f) => f(r)));
        if (range) rows = rows.slice(range[0], range[1] + 1);
        if (limitN !== null) rows = rows.slice(0, limitN);
        return resolve({ data: single ? (rows[0] ?? null) : rows, error: null });
      }
      for (const p of ([] as Row[]).concat(payload as Row)) t.push({ used_at: new Date().toISOString(), ...p });
      return resolve({ data: null, error: null });
    },
  });
  return b;
}
vi.mock('../supabase.js', () => ({ getSupabase: () => ({ from: (t: string) => builder(t) }) }));

import { writeComment, writeReply } from './VoiceWriter.js';
import { briefForAsset, briefForPost } from './PostBrief.js';
import { composeCaption, composeComment, composeReply, agentOf, relevanceOf, RELEVANCE_FLOOR } from './Composer.js';
import { styleSheetFor } from './StyleSheet.js';
import { decideReply, composerReason, type ThreadComment } from './ReplyEngine.js';
import { fleetHash } from './FleetScheduler.js';

function fleetIds(n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const h = fleetHash(String(i), 'vg-a').toString(16).padStart(8, '0');
    const g = fleetHash(String(i), 'vg-b').toString(16).padStart(8, '0');
    ids.push(`${h}-${g.slice(0, 4)}-4${g.slice(4, 7)}-8${h.slice(1, 4)}-${g}${h.slice(0, 4)}`);
  }
  return ids;
}

/** Every sentence as a bare key, openers off: the comparison a reader makes. */
const OPENERS = ['i keep coming back to this', 'the part i keep coming back to', 'the detail worth noticing', 'one thing stands out', 'the interesting part', 'on another watch', 'my first thought', 'at first glance', 'what gets me', 'the thing is', 'in fairness', 'to be fair', 'fair enough', 'one thing', 'honestly', 'for me', 'okay', 'well', 'look'];
function sentencesOf(text: string): string[] {
  return text.toLowerCase().split(/[.!?…\n]+/).map((raw) => {
    let s = raw.trim();
    for (const o of OPENERS) if (s.startsWith(`${o}, `)) { s = s.slice(o.length + 2); break; }
    return s.replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  }).filter((s) => s.length > 8);
}
/** The last thing said, however short ("thoughts?"), openers off. */
function lastSaid(text: string): string {
  const parts = text.toLowerCase().replace(/\?\s*$/, '').split(/[.!?…\n]+/).map((x) => x.trim()).filter(Boolean);
  let s = parts.pop() ?? '';
  for (const o of OPENERS) if (s.startsWith(`${o}, `)) { s = s.slice(o.length + 2); break; }
  return s.replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

// Real titles from the p2-voice-c fixtures (production sports_clips/poker_clips, oEmbed titles).
const SPORTS_TITLES: Array<{ title: string; source: string }> = [
  { title: 'Kristaps Porzingis DUNKS From His First Season in The Bay 💥 | #shorts', source: 'Warriors' },
  { title: 'TYRESE MAXEY, JAYLEN BROWN and LEBRON JAMES got into the gym together last month', source: 'NBA' },
  { title: 'STILL the GREATEST dunk of ALL TIME😳', source: 'House of Highlights' },
  { title: 'Stephen Curry Hooping as a Kid | #shorts', source: 'Warriors' },
  { title: 'LUKA MAGIC and his special playmaking returns Oct. 21 as the Lakers open the season', source: 'NBA' },
  { title: 'UNLUCKIEST PLAYS in NFL History: Jim Marshall runs the wrong way', source: 'NFL' },
  { title: 'Bronny, Ziaire, and the squad take on golf ⛳️ #lakers', source: 'Lakers' },
  { title: 'Your first look at Paul George 👀 #celtics #nba #shorts', source: 'Celtics' },
  { title: '"What\'s next?" An all-new All-Access: Global Scouting is out now!', source: 'Bucks' },
  { title: '2026 NBA Draft | Nate Ament Draft Phone Call', source: 'Bucks' },
  { title: "🔥 Listen to 'Light It Up' on Behind the Bucks, presented by Gallagher", source: 'Bucks' },
  { title: 'Keyboard shortcuts', source: 'Warriors' },
];
const POKER_WORDS = /\b(card|cards|bricks?|stakes?|sizing|river|flop|bluff\w*|pots?|hand|hands|fold\w*|chips?|all in|shove\w*|bankroll|variance|solver|tilt|table|deck)\b/i;
const TEAM_WORDS = /\b(warriors|lakers|celtics|bucks|cowboys)\b/i;
const NOT_PEOPLE = ['Suddenly', 'Streamer', 'Oct', 'Listen', 'Draft', 'History', 'Chip', 'Chair', 'Your', 'Global Scouting', 'Bronny Ziaire', 'Pass', 'Light', 'Behind', "What's"];

beforeEach(() => {
  db.tables = {};
  db.failReads = new Set();
});

describe('P2C-01 a comment speaks the post\'s own language and names only who it can', () => {
  it('no poker words, no team and no invented person under real sports titles', () => {
    for (const { title, source } of SPORTS_TITLES) {
      const brief = briefForPost({ postId: `s:${title}`, contentType: 'link', content: '', linkTitle: title, linkSiteName: source, metadata: { clip_type: 'sports' } });
      for (const id of fleetIds(60)) {
        const t = composeComment(brief, styleSheetFor(id)).text;
        expect(t, `${title} -> ${t}`).not.toMatch(POKER_WORDS);
        expect(t, `${title} -> ${t}`).not.toMatch(TEAM_WORDS);
        for (const fake of NOT_PEOPLE) expect(t.toLowerCase(), `${title} -> ${t}`).not.toContain(fake.toLowerCase() + ' ');
      }
    }
  });

  it('an unplaceable post gets silence, not card talk', () => {
    const brief = briefForPost({ postId: 'g1', contentType: 'link', content: '', linkTitle: "Codie Sanchez's Brutally Honest Advice on Getting Rich", linkSiteName: 'BotezLive', metadata: null });
    for (const id of fleetIds(60)) expect(composeComment(brief, styleSheetFor(id)).text).toBe('');
  });

  it('praise needs something in the title to praise', () => {
    // "Codie Sanchez made that look simple" was published under a business
    // interview that a poker channel had uploaded.
    const brief = briefForAsset({ kind: 'video', title: "Codie Sanchez's Brutally Honest Advice on Getting Rich", source: 'BotezLive', domainHint: 'poker' });
    for (const id of fleetIds(60)) {
      expect(composeComment(brief, styleSheetFor(id)).text).not.toMatch(/codie|sanchez|made that look/i);
    }
  });
});

describe('P2C-07 the channel is not a player, and a capital is not a name', () => {
  it('the uploading team never becomes the actor', () => {
    const b = briefForAsset({ kind: 'video', title: 'Kristaps Porzingis DUNKS From His First Season in The Bay 💥 | #shorts', source: 'Warriors', domainHint: 'sports' });
    expect(b.teams).toEqual([]);
    expect(agentOf(b)).toBe('Kristaps Porzingis');
    for (const id of fleetIds(80)) {
      expect(composeCaption(b, styleSheetFor(id)).text).not.toMatch(/warriors/i);
    }
    const junk = briefForAsset({ kind: 'video', title: 'Keyboard shortcuts', source: 'Warriors', domainHint: 'sports' });
    expect(junk.teams).toEqual([]);
  });

  it('adverbs, months, generic nouns and lists are not people', () => {
    const titles = [
      'Suddenly my river bluff doesn’t seem so scary 😂 #natural8 #poker',
      'Streamer loltyler1 does NOT like his odds at hitting his flush 😂',
      'Just a Chip and a Chair',
      ...SPORTS_TITLES.map((s) => s.title),
    ];
    for (const title of titles) {
      const b = briefForAsset({ kind: 'video', title, source: 'NBA' });
      for (const fake of NOT_PEOPLE) expect(b.people, title).not.toContain(fake);
      expect(b.people.join('|'), title).not.toMatch(/History Jim|Bronny Ziaire|George\/|Summer League/);
    }
  });

  it('a private name in a shared link title is never said, however the comment is shaped (P2C-12)', () => {
    const brief = briefForPost({
      postId: 'l1', contentType: 'link', content: 'look at this',
      linkTitle: "Marcus Delaney's triple barrel river bluff at the Bike",
      linkSiteName: 'PokerNews', metadata: { news_type: 'poker' },
    });
    expect(brief.people).toEqual([]);
    let spoke = 0;
    for (const id of fleetIds(120)) {
      const t = composeComment(brief, styleSheetFor(id)).text;
      if (t) spoke++;
      expect(t).not.toMatch(/marcus|delaney/i);
    }
    expect(spoke).toBeGreaterThan(60);
  });
});

describe('P2C-06 a take states an event only when the title does', () => {
  it('WSOP is a series, not a bracelet, and Pot Limit is a game, not a pot', () => {
    const wsop = briefForAsset({ kind: 'video', title: 'The BEST & WORST Hands From WSOP Canada', source: 'World Series of Poker', domainHint: 'poker' });
    expect(wsop.concepts).not.toContain('bracelet');
    expect(wsop.concepts).toContain('tournament');
    const plo = briefForAsset({ kind: 'video', title: 'POT LIMIT OMAHA FOREVER!!! FUN POKER IN LOS ANGELES!- Live at the Commerce', source: 'Bally Poker Live', domainHint: 'poker' });
    expect(plo.concepts).not.toContain('pot');
    expect(plo.concepts).toContain('plo');
  });

  it('no win, streets or session is claimed for a title that states none', () => {
    const cases = [
      'I Played The WSOP Canada Main Event!! (Every Hand of Day 1)',
      'The BEST & WORST Hands From WSOP Canada',
      'everyone is WRONG about BLUFFING #poker #texasholdem #shorts',
      'POT LIMIT OMAHA FOREVER!!! FUN POKER IN LOS ANGELES!- Live at the Commerce',
    ];
    for (const title of cases) {
      const b = briefForAsset({ kind: 'video', title, source: 'PokerGO', domainHint: 'poker' });
      for (const id of fleetIds(120)) {
        const t = composeCaption(b, styleSheetFor(id)).text.toLowerCase();
        expect(t, title).not.toMatch(/the win|bracelet|that many streets|all session|a pot that size|pot gets the headline/);
      }
    }
  });

  it('the same takes are still said when the title does state the event', () => {
    const b = briefForAsset({ kind: 'link', title: 'Phil Ivey Wins 11th WSOP Bracelet', source: 'CardPlayer' });
    const texts = fleetIds(200).map((id) => composeCaption(b, styleSheetFor(id)).text.toLowerCase());
    expect(texts.some((t) => /bracelet/.test(t))).toBe(true);
  });
});

describe('P2C-10 a question is the last thing said', () => {
  it('no question mark after an ellipsis, a full stop or a verdict line', () => {
    const titles = [
      'Suddenly my river bluff doesn’t seem so scary 😂 #natural8 #poker',
      'why your bankroll is tiny...',
      'Daniel Negreanu’s Secret Exploit Vs Canadians!',
      'STILL the GREATEST dunk of ALL TIME😳',
    ];
    const Q = /^(what|whats|how|why|who|where|when|which|is|are|do|does|did|would|could|should|can|will|anyone|am|thoughts|curious)\b/;
    for (const title of titles) {
      const b = briefForAsset({ kind: 'video', title, source: 'Natural8', domainHint: /dunk/i.test(title) ? 'sports' : 'poker' });
      for (const id of fleetIds(150)) {
        for (const t of [composeCaption(b, styleSheetFor(id)).text, composeComment(b, styleSheetFor(id)).text]) {
          if (!t.includes('?')) continue;
          expect(t, t).toMatch(/\?$/);
          expect(t.slice(0, -1), t).not.toContain('?');
          expect(t, t).not.toMatch(/(…|\.)\s*\?$/);
          expect(lastSaid(t), t).toMatch(Q);
        }
      }
    }
  });
});

describe('P2C-11 closers rotate instead of signing every post', () => {
  it('a tag-question horse does not end every caption with the same question', () => {
    const titles = [
      'Suddenly my river bluff doesn’t seem so scary', 'why your bankroll is tiny...', 'Where Do MTT Players Have the Biggest Edge?',
      'every pot was worth more than a ferrari', 'Daniel Negreanu’s Secret Exploit Vs Canadians!', 'My Greatest Comeback EVER Playing HIGH STAKES Poker!',
      'The BEST & WORST Hands From WSOP Canada', 'everyone is WRONG about BLUFFING',
    ].map((title) => briefForAsset({ kind: 'video', title, source: 'PokerGO', domainHint: 'poker' }));
    const taggers = fleetIds(400).map(styleSheetFor).filter((s) => s.closer === 'tag_question').slice(0, 20);
    expect(taggers.length).toBeGreaterThan(5);
    for (const style of taggers) {
      const endings = new Set(titles.map((b) => composeCaption(b, style).text).filter(Boolean).map((t) => lastSaid(t)));
      expect(endings.size, style.profileId).toBeGreaterThan(1);
    }
  });

  it('a verdict horse does not close every post with a verdict', () => {
    const b = briefForAsset({ kind: 'video', title: 'Where Do MTT Players Have the Biggest Edge?', source: 'Run It Once', domainHint: 'poker' });
    const verdictHorses = fleetIds(400).map(styleSheetFor).filter((s) => s.closer === 'verdict').slice(0, 30);
    let closed = 0;
    let total = 0;
    for (const style of verdictHorses) {
      for (let v = 0; v < 6; v++) {
        const t = composeCaption(b, style, String(v)).text;
        if (!t) continue;
        total++;
        const last = lastSaid(t);
        if (style.lexicon.verdicts.some((vd) => vd.toLowerCase().replace(/[^a-z0-9 ]/g, '') === last)) closed++;
      }
    }
    expect(total).toBeGreaterThan(100);
    expect(closed / total).toBeLessThan(0.6);
  });
});

describe('P2C-02 a reply answers the comment it sits under', () => {
  const now = new Date('2026-09-21T12:00:00Z');
  const ago = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
  const horse = fleetIds(1)[0]!;
  const post = { postId: 'p-r1', contentType: 'video', content: "The bluff's the easy part, the sizing is what sells it.", metadata: { clip_type: 'poker' } };
  const thread = (content: string): ThreadComment[] => [
    { id: 'root', post_id: 'p-r1', parent_id: null, author_id: horse, content: 'the sizing is what sells it', created_at: ago(60), isHorse: true },
    { id: 'h1', post_id: 'p-r1', parent_id: 'root', author_id: 'human-1', content, created_at: ago(10), isHorse: false },
  ];

  it('a human who raises something gets a publishable answer about it', async () => {
    db.tables.post_briefs = [{ post_id: 'p-r1', kind: 'video', domain: 'poker', title: 'Suddenly my river bluff doesn’t seem so scary', concepts: ['bluff', 'river'], people: [], teams: [], amounts: [], tone: 'neutral', confidence: 0.6 }];
    for (const said of ['would you have folded the river there?', 'that bluff was way too big', 'disagree, the river call was bad']) {
      const d = decideReply(horse, 'myalias', thread(said), now);
      expect(d.reply).toBe(true);
      expect(d.reason).toBe('human_unanswered');
      const w = await writeReply({ profile_id: horse }, post, d.target!.content, composerReason(d.reason!, d.target!.content));
      expect(w.text, said).not.toBe('');
      expect(w.skipReason).toBeUndefined();
      expect(w.relevance).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
      expect(w.text.toLowerCase(), said).toMatch(/fold|river|bluff|call/);
    }
  });

  it('an empty or off-topic comment is an explicit skip, not silent filler', async () => {
    for (const said of ['nice', 'what time does the stream start tonight?', 'anyone know a good pizza place in Boston?', '']) {
      const w = await writeReply({ profile_id: horse }, post, said, composerReason('human_unanswered', said));
      expect(w.text, said).toBe('');
      expect(w.skipReason, said).toBe('reply_ungrounded');
    }
  });

  it('never says a name out of a human comment unless it is a public figure', () => {
    const b = briefForAsset({ kind: 'video', title: 'Suddenly my river bluff doesn’t seem so scary', source: 'Natural8', domainHint: 'poker' });
    for (const id of fleetIds(60)) {
      const t = composeReply(b, styleSheetFor(id), 'Dan Bekavac would have folded that river, right?', 'question').text;
      expect(t).not.toMatch(/bekavac|dan /i);
      const ivey = composeReply(b, styleSheetFor(id), 'would Phil Ivey have called there?', 'question');
      expect(ivey.text.toLowerCase()).toContain('phil ivey');
      expect(relevanceOf(ivey.text, { ...b, people: ['Phil Ivey'], concepts: [] })).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
    }
  });
});

describe('P2C-05 a comment never repeats what the post already says', () => {
  const caption = 'Tournament poker rewards surviving more than winning pots. Tournament poker is a marathon, not a sprint.';
  const post = { postId: 'p-c1', contentType: 'video', content: caption, linkTitle: null, linkSiteName: null, metadata: { clip_type: 'poker' } };

  beforeEach(() => {
    db.tables.post_briefs = [{ post_id: 'p-c1', kind: 'video', domain: 'poker', title: 'Where Do MTT Players Have the Biggest Edge?', concepts: ['tournament'], people: [], teams: [], amounts: [], tone: 'analytical', confidence: 0.6 }];
  });

  it('no sentence of the caption comes back in a comment under it', async () => {
    const taken = new Set(sentencesOf(caption));
    let spoke = 0;
    for (const id of fleetIds(60)) {
      const w = await writeComment({ profile_id: id }, post);
      if (!w.text) continue;
      spoke++;
      for (const s of sentencesOf(w.text)) expect(taken.has(s), w.text).toBe(false);
    }
    expect(spoke).toBeGreaterThan(20);
  });

  it('nor any sentence of a comment already under it', async () => {
    const existing = [
      { post_id: 'p-c1', content: 'Surviving the long days is half of tournament poker.' },
      { post_id: 'p-c1', content: 'honestly, the tournament grind is brutal and people still line up for it' },
    ];
    db.tables.social_comments = existing;
    const taken = new Set([...sentencesOf(caption), ...existing.flatMap((r) => sentencesOf(r.content))]);
    for (const id of fleetIds(60)) {
      const w = await writeComment({ profile_id: id }, post);
      for (const s of sentencesOf(w.text)) expect(taken.has(s), w.text).toBe(false);
    }
  });

  it('an unreadable thread is a reason to stay quiet (fail closed)', async () => {
    db.failReads.add('social_comments');
    const w = await writeComment({ profile_id: fleetIds(1)[0]! }, post);
    expect(w.text).toBe('');
    expect(w.skipReason).toBe('post_thread_unreadable');
  });
});

describe('resumed 2026-09-29: what the rebased harness run still showed', () => {
  it('a pushback lead never asserts a detail the title does not carry (no sizing talk under a bankroll video)', () => {
    // Harness C2 on the rebased head: "Respectfully, the sizing tells a
    // different story. Nobody plans to go broke, they just skip the bankroll
    // part." under "why your bankroll is tiny..." (no sizing anywhere).
    const brief = briefForAsset({ kind: 'video', title: 'why your bankroll is tiny...', source: 'Hungry Horse Poker', domainHint: 'poker' });
    let spoke = 0;
    for (const id of fleetIds(200)) {
      const t = composeComment(brief, styleSheetFor(id)).text;
      if (t) spoke++;
      expect(t.toLowerCase(), t).not.toMatch(/sizing/);
    }
    expect(spoke).toBeGreaterThan(20);
  });

  it('a human calling it a bad call is answered about the call (P2C-02)', () => {
    // Harness R: "disagree, I think that was a bad call" under a poker post
    // was skipped as reply_ungrounded on all 10 poker posts.
    const brief = briefForAsset({ kind: 'video', title: 'every pot was worth more than a ferrari', source: 'Hungry Horse Poker', domainHint: 'poker' });
    for (const id of fleetIds(40)) {
      const r = composeReply(brief, styleSheetFor(id), 'disagree, I think that was a bad call', 'disagreement');
      expect(r.skip).toBeUndefined();
      expect(r.text.toLowerCase()).toMatch(/the call/);
      expect(r.relevance).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
    }
  });
});
