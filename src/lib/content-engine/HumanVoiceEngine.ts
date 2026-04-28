// @ts-nocheck — JS-port file, runtime behavior verified against monolith JS source

/**
 * HumanVoiceEngine — Phase 2B.2-followup port (2026-04-26)
 *
 * Ported from src/content-engine/pipeline/HumanVoiceEngine.js (1217 LOC).
 *
 * Generates human-sounding poker captions, comments, news takes, and
 * DM replies. Pattern-based with no AI calls (zero API cost) — uses
 * deterministic per-horse style hashing for unique voices.
 *
 * Dan's v3.0 humanization improvements (commits c8279b5d2,
 * 2d2e59365, 83e3d4ed4) preserved verbatim.
 */

/**
 * HumanVoiceEngine.js — v3.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Zero-cost, zero-API human voice generation for horse social posts.
 *
 * Key guarantees:
 *   • No horse repeats a phrase used in their last 15 posts
 *   • No two horses use the same phrase on the same post (cross-horse dedup)
 *   • Every horse has a consistent but distinct voice archetype
 *   • No AI-pattern phrases (blader/humanizer 29-rule implementation)
 *   • Question comments injected 18% of time for authenticity
 *   • Time-of-day voice shift: night = more casual, morning = more sharp
 *   • Structural variety: short (2-3w), medium (5-9w), long (10-15w) mixed
 *
 * Implementation: in-memory dedupe map + per-post cross-horse registry
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── In-memory dedup tracking ─────────────────────────────────────────────────
// Map<profileId, { lastUsed: string[], dayKey: string, dayUsed: Set<string> }>
const horseMemory: Map<string, string[]> = new Map();
const MEMORY_DEPTH = 15; // last N phrases remembered per horse

// ─── Cross-horse post-level comment registry ──────────────────────────────────
// Prevents multiple horses from posting the same comment on the same post.
// Map<postId, Set<string (normalized phrase)>> — auto-expires after 2h
const POST_COMMENT_REGISTRY = new Map();
const POST_REGISTRY_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function registerCommentOnPost(postId, phrase) {
  if (!postId) return;
  const now = Date.now();
  // Prune expired entries
  for (const [pid, entry] of POST_COMMENT_REGISTRY) {
    if (now - entry.ts > POST_REGISTRY_TTL_MS) POST_COMMENT_REGISTRY.delete(pid);
  }
  if (!POST_COMMENT_REGISTRY.has(postId)) {
    POST_COMMENT_REGISTRY.set(postId, { ts: now, phrases: new Set() });
  }
  POST_COMMENT_REGISTRY.get(postId).phrases.add(phrase.toLowerCase().trim());
}

function isAlreadyCommentedOnPost(postId, phrase) {
  if (!postId) return false;
  const entry = POST_COMMENT_REGISTRY.get(postId);
  if (!entry) return false;
  return entry.phrases.has(phrase.toLowerCase().trim());
}

function getTodayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

function getHorseMemory(profileId) {
  if (!horseMemory.has(profileId)) {
    horseMemory.set(profileId, { lastUsed: [], dayKey: getTodayKey(), dayUsed: new Set() });
  }
  const mem = horseMemory.get(profileId);
  // Reset daily tracking on new day
  const today = getTodayKey();
  if (mem.dayKey !== today) {
    mem.dayKey = today;
    mem.dayUsed = new Set();
  }
  return mem;
}

function recordUsed(profileId, phrase) {
  const mem = getHorseMemory(profileId);
  mem.lastUsed.unshift(phrase);
  if (mem.lastUsed.length > MEMORY_DEPTH) mem.lastUsed.pop();
  mem.dayUsed.add(phrase.toLowerCase().trim());
}

function isRecentlyUsed(profileId, phrase) {
  const mem = getHorseMemory(profileId);
  const norm = phrase.toLowerCase().trim();
  return mem.lastUsed.some(p => p.toLowerCase().trim() === norm) ||
         mem.dayUsed.has(norm);
}

// ─── Per-horse hash ───────────────────────────────────────────────────────────
function getHorseHash(profileId) {
  if (!profileId) return 0;
  let h = 0;
  for (let i = 0; i < profileId.length; i++) {
    h = ((h << 5) - h) + profileId.charCodeAt(i);
    h = h & h;
  }
  return Math.abs(h);
}

// ─── Personality archetypes ───────────────────────────────────────────────────
// Each horse gets one locked-in archetype via hash — defines their TENDENCIES,
// not their fixed behavior. applyStyle injects randomness so the same horse
// never looks identical post after post.
const ARCHETYPES = [
  { id: 'blunt',         capStyle: 'all_lower',  punct: 'none',        flair: ['real talk', 'honestly', 'ngl'] },
  { id: 'analytical',   capStyle: 'normal',     punct: 'minimal',     flair: ['solver take', 'GTO note', 'range perspective'] },
  { id: 'hype',         capStyle: 'normal',     punct: 'none',        flair: ['massive', 'huge', 'unreal'] },
  { id: 'dry',          capStyle: 'all_lower',  punct: 'none',        flair: ['sure', 'of course', 'classic'] },
  { id: 'veteran',      capStyle: 'normal',     punct: 'minimal',     flair: ['textbook', 'seen it', 'classic spot'] },
  { id: 'casual',       capStyle: 'all_lower',  punct: 'none',        flair: ['ngl', 'lowkey', 'kinda'] },
  { id: 'skeptical',    capStyle: 'all_lower',  punct: 'none',        flair: ['idk', 'not convinced', 'questionable'] },
  { id: 'excitable',    capStyle: 'first_cap',  punct: 'enthusiastic', flair: ['wait', 'hold on', 'ok but'] },
  { id: 'terse',        capStyle: 'all_lower',  punct: 'none',        flair: [] },
  { id: 'conversational', capStyle: 'first_cap', punct: 'normal',    flair: ['honestly', 'look', 'thing is'] },
];

function getArchetype(profileId) {
  return ARCHETYPES[getHorseHash(profileId) % ARCHETYPES.length];
}

// ─── Anti-AI cleanup (blader/humanizer 29 patterns) ──────────────────────────
const AI_SCRUB = [
  [/\b(serves|stands|functions|acts)\s+as\b/gi, 'is'],
  [/\b(underscores?|highlights?|showcases?|emphasizes?)\s+its?\b/gi, 'shows'],
  [/\b(pivotal|crucial|vital|significant)\s+(moment|role|step)\b/gi, 'big'],
  [/\b(evolving|ever-changing)\s+landscape\b/gi, 'field'],
  [/\b(testament|reminder)\s+to\b/gi, 'proof of'],
  [/\bIn order to\b/gi, 'To'],
  [/\bDue to the fact that\b/gi, 'Because'],
  [/\bAt this point in time\b/gi, 'Now'],
  [/\bIt is important to note that\b/gi, ''],
  [/\bNot only .+? but also\b/gi, 'and also'],
  [/\bLet's (dive in|explore|break this down)\b/gi, ''],
  [/\bWithout further ado\b/gi, ''],
  [/\b(Additionally|Furthermore|Moreover),?\s*/gi, ''],
  [/\b(groundbreaking|game-changing|revolutionary)\b/gi, 'solid'],
  [/\b(vibrant|bustling|thriving)\b/gi, 'active'],
  [/\bbreathtaking\b/gi, 'impressive'],
  [/\bIntriguing (poker|moment|play|strategy)\b/gi, 'worth watching'],
  [/\bCautiously hopeful\b/gi, 'hoping'],
  [/\bMastering the\b/gi, 'working on the'],
  [/\bGreat advice for\b/gi, 'solid tip for'],
  [/\bInteresting (strategy|spot|line|concept)\b/gi, (_, w) => `notable ${w}`],
  [/\bHmph,?\s*/gi, ''],
  [/\s{2,}/g, ' '],
];

function scrub(text) {
  let out = text;
  for (const [p, r] of AI_SCRUB) out = out.replace(p, r);
  return out.trim();
}

// ─── Style application ────────────────────────────────────────────────────────
// Each archetype defines a TENDENCY, not a fixed rule.
// Randomness is injected so the same horse varies post to post.
// Goal: no two consecutive posts look structurally identical.
function applyStyle(text, archetype) {
  let out = scrub(text);

  // Strip trailing punctuation before any style is applied
  out = out.replace(/[.!?,;]+$/, '').trim();

  // ── Capitalization: archetype tendency + random drift ──────────────────────
  // 'all_lower' horses: 70% stay lower, 20% capitalize first word, 10% normal
  // 'first_cap' horses: 75% capitalize first word, 15% all lower, 10% normal
  // 'normal' horses: 60% unchanged, 25% first_cap, 15% all lower
  const capRoll = Math.random();
  const cs = archetype.capStyle;
  if (cs === 'all_lower') {
    if (capRoll < 0.70) out = out.toLowerCase();
    else if (capRoll < 0.90) out = out[0].toUpperCase() + out.slice(1).toLowerCase();
    else { /* leave as-is (normal) */ }
  } else if (cs === 'first_cap') {
    if (capRoll < 0.75) out = out[0].toUpperCase() + out.slice(1);
    else if (capRoll < 0.90) out = out.toLowerCase();
    else { /* leave as-is */ }
  } else { // 'normal'
    if (capRoll < 0.60) { /* leave as-is */ }
    else if (capRoll < 0.85) out = out[0].toUpperCase() + out.slice(1);
    else out = out.toLowerCase();
  }

  // ── Punctuation: archetype tendency + random drift ─────────────────────────
  // 'none' horses: 65% no punct, 25% period, 10% nothing (already done)
  // 'minimal' horses: 50% period, 30% nothing, 20% comma then next thought
  // 'enthusiastic' horses: 50% '!', 30% '!!', 20% nothing
  // 'ellipsis' horses: 50% '...', 30% nothing, 20% period (NOT always '...')
  // 'normal' horses: 45% period, 30% nothing, 15% '?', 10% comma-tail
  const punctRoll = Math.random();
  const p = archetype.punct;
  if (p === 'none') {
    if (punctRoll > 0.75) out += '.';
    // else: no punct
  } else if (p === 'minimal') {
    if (punctRoll > 0.50) out += '.';
    // else: no punct
  } else if (p === 'enthusiastic') {
    if (punctRoll > 0.70) out += '!!';
    else if (punctRoll > 0.30) out += '!';
    // else: no punct (20%)
  } else if (p === 'ellipsis') {
    if (punctRoll > 0.50) out += '...';
    else if (punctRoll > 0.20) out += '.';
    // else: no punct (20%)
  } else { // 'normal'
    if (punctRoll < 0.55) { /* no punct (55%) */ }
    else if (punctRoll < 0.82) out += '.';  // period (27%)
    else if (punctRoll < 0.92) out += '?';  // question (10%)
    // else nothing additional (8%)
  }

  return out.trim();
}


// ─── Question-specific style (preserves the ? mark) ─────────────────────────
// Regular applyStyle strips trailing ? because it treats all punct uniformly.
// Questions need the ? preserved — only apply capitalization, not punct.
function applyQuestionStyle(text, archetype) {
  let out = scrub(text).trim();
  // Strip trailing period/comma/exclamation only — NOT question mark
  out = out.replace(/[.!,;]+$/, '').trim();
  // Apply capitalization based on archetype (same logic as applyStyle)
  const capRoll = Math.random();
  const cs = archetype.capStyle;
  if (cs === 'all_lower') {
    if (capRoll < 0.65) out = out.toLowerCase();
    else out = out[0].toUpperCase() + out.slice(1).toLowerCase();
  } else if (cs === 'first_cap') {
    if (capRoll < 0.80) out = out[0].toUpperCase() + out.slice(1);
    else out = out.toLowerCase();
  } else {
    if (capRoll < 0.65) { /* leave as-is */ }
    else if (capRoll < 0.85) out = out[0].toUpperCase() + out.slice(1);
    else out = out.toLowerCase();
  }
  // Ensure question mark is at the end
  if (!out.endsWith('?')) out = out.replace(/[.!,;?]*$/, '') + '?';
  return out.trim();
}

// ─── Structural length variance ───────────────────────────────────────────────
// Ensures mix of short (1-4 words), medium (5-9), and longer phrases.
// Pool selection is seeded by horse + time so patterns shift naturally.
// Per-horse call counter — increments monotonically, breaks timeBucket ties
const horsePick = new Map();
function nextPickOffset(profileId) {
  const n = (horsePick.get(profileId) || 0) + 1;
  horsePick.set(profileId, n);
  return n;
}

function pickFromPool(pool, profileId, salt = 0) {
  const h = getHorseHash(profileId);
  // Rotate seed every 4 hours + monotonic per-call counter to guarantee variance
  const timeBucket = Math.floor(Date.now() / (1000 * 60 * 60 * 4));
  const callN = nextPickOffset(profileId);
  const base = (h + timeBucket + salt + callN) % pool.length;
  // Try every candidate in order, skip recently used
  for (let i = 0; i < pool.length; i++) {
    const candidate = pool[(base + i) % pool.length];
    if (!isRecentlyUsed(profileId, candidate)) return candidate;
  }
  // All used — rotate by callN to avoid always returning pool[0]
  return pool[callN % pool.length];
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST CAPTION POOLS
// Each pool has short, medium, long entries mixed in to ensure structural variety.
// ═══════════════════════════════════════════════════════════════════════════════
const POST_CAPTIONS = {

  massive_pot: [
    // Short
    'stack going in', 'big money', 'pot got out of hand', 'two big hands collide',
    'all in', 'monster pot', 'it went in', 'massive',
    // Medium
    'that pot got huge fast', 'not sure who I\'m rooting for', 'someone\'s night just changed',
    'chips were moving fast in that one', 'both players had a read, or thought they did',
    'pot size changes the math on everything', 'the swings in this game are real',
    'the money went in fast on that one', 'when both players feel good about it',
    'all the chips are in the middle', 'this is why people watch poker',
    // Longer
    'that\'s a lot of money in the middle for one hand', 'looked calm at the table, was not calm',
    'both ran it like they knew something the other didn\'t', 'nobody blinked. respect.',
    'the stacks got deep enough that everything after the flop was interesting',
    'this hand changed the whole trajectory of the session',
    'getting it all in pre is one thing, this was different',
    'sometimes you just know going into it that it\'s going to be big',
  ],

  bluff: [
    // Short
    'pure stones', 'zero cards', 'had nothing', 'ran it anyway',
    // Medium
    'he had nothing and bet it big', 'that bluff had no business working',
    'cold as ice at that table', 'the nerve to pull that off in that spot',
    'the river bet was the whole story', 'they bought the story completely',
    // Longer
    'that sizing was a statement, not a question', 'didn\'t flinch once during the whole hand',
    'bluff worked. should it have? probably not.', 'put a story together and they believed it',
    'pure aggression, zero cards, full commitment',
  ],

  bad_beat: [
    // Short
    'brutal', 'runner runner', 'variance', 'oof', 'the deck lied',
    // Medium
    'ran good until he didn\'t', 'had it won then didn\'t',
    'the river card was brutal', 'nobody deserves that runout',
    'played it right, lost anyway. that\'s poker',
    // Longer
    'the math was right, the cards had other plans', 'been there. it sucks every single time.',
    'that one-outer hits different when there\'s money on it',
    'this hand lives rent-free in his head now', 'sometimes the deck just doesn\'t care',
  ],

  soul_read: [
    // Short
    'he knew', 'no way that\'s a guess', 'dialed in',
    // Medium
    'that fold was either genius or instinct', 'called it before the cards came',
    'saw right through the story', 'the timing on that call was different',
    'reads like that don\'t come from a solver', 'hero call, actually earned the name',
    // Longer
    'how do you make that lay down at that stack depth', 'not many people make that call in that spot',
    'snapped it off like he\'d played this exact spot before',
    'the look on his face said he already knew what was coming',
  ],

  table_drama: [
    // Short
    'table got weird', 'someone snapped', 'tension was real',
    // Medium
    'the table shifted after that hand', 'words exchanged, not nice ones',
    'two people, one pot, bad energy', 'someone\'s composure cracked',
    'the dealer had the hardest job at that table',
    // Longer
    'takes a lot to rattle some people, this did it',
    'whatever was said, it got in his head and stayed there',
    'nobody wins when the table tilts like that',
  ],

  celebrity: [
    // Short
    'legend stuff', 'still elite', 'different level',
    // Medium
    'hard not to watch when he\'s at the table', 'some things don\'t change',
    'built the reputation hand by hand', 'watched this guy play for years, still impressive',
    // Longer
    'the name carries weight for a reason', 'you can learn something from every hand he plays',
    'that\'s just a different feel for the game, hard to teach',
  ],

  funny: [
    // Short
    'did not expect that', 'poker is comedy', 'I can\'t',
    // Medium
    'watched this three times already', 'the table didn\'t know how to process it',
    'nobody planned for that outcome', 'poker finds a way to surprise you',
    // Longer
    'this hand will come up in conversation for years',
    'the reaction was as good as the hand itself',
    'genuinely did not see that ending coming',
  ],

  educational: [
    // Short
    'worth watching twice', 'note the sizing', 'study this spot',
    // Medium
    'a lot of players get this wrong', 'the decision tree here is worth thinking about',
    'simple concept, harder to execute in game', 'position doing all the work here',
    'pay attention to how they play the turn',
    // Longer
    'this is the spot that separates levels of play',
    'stack depth is doing a lot of work in this hand, good study material',
    'range advantage playing out in real time, worth pausing and rewinding',
    'the river decision is the one worth studying before your next session',
  ],

  vlog: [
    // Short
    'the grind continues', 'living it', 'another session',
    // Medium
    'honest look at how a session actually goes', 'the variance in this game is real',
    'every session teaches you something', 'running good is temporary, grinding is permanent',
    // Longer
    'good read on the room throughout the whole session',
    'not every day is a winning day. he knows that better than most',
  ],

  tournament: [
    // Short
    'ICM pressure', 'deep run loading', 'final table energy',
    // Medium
    'chip lead means nothing until it\'s over',
    'tournament poker needs a different gear', 'one hand from a life-changing score',
    'the shove/fold math gets real near the money',
    // Longer
    'stack management under pressure is a skill people underestimate',
    'field was tough, still made a run and played it well',
    'late registration vs early grind, that debate never ends',
  ],

  high_stakes: [
    // Short
    'real numbers', 'different game entirely', 'no soft spots',
    // Medium
    'the range of players at this level is wild', 'mistakes at these stakes cost accordingly',
    'that bet sizing sends a message to the whole table',
    'nobody at this table is guessing',
    // Longer
    'you can feel the pressure through the screen on this one',
    'the mental game matters more as stakes go up, and this shows it',
  ],

  // ── Sports highlight video captions (used when clipType === 'sports') ──────────
  sports_highlight: [
    // Very short (2-3 words) — adds range variety
    'just money', 'that\'s different', 'nasty', 'no way', 'ice cold',
    'look at that', 'wow', 'come on',
    // Short (4-6 words)
    'that was filthy', 'did not see that coming', 'highlight of the week',
    'has to be a poster', 'nobody touches him when he\'s on',
    // Medium (7-12 words)
    'not many people can do what he just did there',
    'that play changes how you think about the game',
    'the athleticism on display is wild', 'the best players make it look easy',
    'moment of the game right there', 'that\'s going on the highlight reel',
    'whole arena felt that one', 'the footwork alone is worth studying',
    'built different. that\'s the only explanation.',
    'you practice that a thousand times and still might not pull it off in-game',
    // Longer (13+ words)
    'plays like that don\'t happen without years of work behind them',
    'whoever was guarding that man was in a bad spot from the start',
    'the timing on that was absolutely perfect. you just can\'t teach that.',
    'hard to watch that and not appreciate how good these athletes are',
    'this is why you watch every game, moments like this happen fast',
    'the crowd reaction said everything that needed to be said',
    'breakdown of that play frame by frame would be something else',
    'the gap between good and elite becomes very obvious in moments like this',
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMMENT POOLS
// ═══════════════════════════════════════════════════════════════════════════════
const COMMENT_PHRASES = {

  video: [
    'this hand is something', 'watched it twice', 'the timing on that was different',
    'hard to argue with that result', 'not sure I make that call there',
    'the river changes everything', 'seen a lot of hands, that one stands out',
    'the bet sizing tells the whole story', 'cold as ice',
    'that read was there before the cards came', 'position doing all the work',
    'would\'ve played it the same way', 'probably not the solver line but it worked',
    'two hours at a table with that guy and you learn something',
    'the blocker logic is real here', 'gutsy. genuinely gutsy.',
    'that fold saved his whole session', 'aggressive line, made sense though',
    'range advantage was obvious in hindsight', 'that call took nerve',
    'classic live poker read', 'the stacks made this play make sense',
  ],

  bad_beat: [
    'brutal', 'that one hurts to watch', 'been there too many times',
    'variance is real', 'the deck had it out for him', 'played it right though',
    'oof', 'one-outers are a special kind of pain', 'the math was right. cards weren\'t.',
    'next session', 'shake it off', 'that kind of thing sticks with you a while',
    'nothing to do but move on', 'happened to me last week. still thinking about it.',
    'awful runout. nothing you can do.', 'that\'s just poker doing poker things',
  ],

  bluff: [
    'no cards needed', 'that took nerve', 'the sizing was a statement',
    'he had to fold there honestly', 'stone cold', 'respect for the execution',
    'fearless at the table', 'risky, worth it',
    'the read was there before the shove', 'everyone at the table knew but nobody moved',
  ],

  tournament: [
    'ICM nightmare spot', 'the bubble is brutal', 'chip leader playing it right',
    'final table spots don\'t come free', 'shove range widens near the money',
    'field was tough, still made it work', 'deep run incoming',
    'tournament poker needs a different gear',
  ],

  strategy: [
    'the sizing tells the story', 'think about it from a range perspective',
    'EV is all that matters long term', 'textbook spot',
    'solver would have a different answer, this works too',
    'position is doing everything here', 'the math checks out',
    'good example of when to deviate from the chart',
  ],

  session_report: [
    'solid session', 'the grind pays off', 'good to book a win',
    'keep stacking', 'the hours show up in the results', 'nice profit',
    'sessions like that keep you going', 'congrats on the run',
  ],

  grind: [
    'respect the process', 'putting in volume', 'every hand counts',
    'outwork the field', 'grind never stops', 'sessions add up',
    'dedication is real', 'the work shows eventually',
  ],

  variance: [
    'variance is a beast', 'the long run sorts it out', 'standard deviation in action',
    'the swings are part of it', 'keep playing your game',
    'downswings end. yours will too.', 'trust the math',
  ],

  // Sports comment pool — used when horses comment on sports posts
  // Must NOT include poker terminology. Keep it natural and varied.
  sports: [
    // Win/result reactions
    'well deserved', 'that W was earned', 'nobody gave them a chance and here we are',
    'statement game', 'momentum is real now', 'squeezed that one out',
    'that\'s how you answer doubters', 'clean execution when it mattered',
    // Loss reactions
    'tough one to watch', 'that one stings', 'gotta bounce back fast',
    'the season just got more interesting', 'happens to the best teams',
    'early in the season, not the end of the world',
    // Records / achievement
    'history being made', 'generational', 'the record stood for a reason',
    'you have to see it to believe it', 'this is what peak performance looks like',
    // Game commentary
    'always tune in for games like this', 'every week is a movie in this league',
    'coaching mattered a lot in this one', 'the league never has a slow stretch',
    'depth of roster showing up right now',
    // Transactions / roster
    'front office making moves', 'bold move', 'someone got a steal here',
    'ripple effects from this will be felt', 'this changes the whole conference picture',
    // General engagement
    'love watching this play out', 'the sport keeps delivering',
    'athletes at this level are just built different', 'respect the grind',
    'could watch this all day', 'the storylines this season are unreal',
    'good time to be a fan', 'hard to look away from this team right now',
    'the preparation behind every play like this is insane',
  ],

  // Photo comment pool — for image posts (not video)
  photo: [
    'great shot', 'the look says everything', 'table presence',
    'reads like a player', 'this photo has energy', 'framing is perfect',
    'captured that moment well', 'says more than a caption could',
    'you can feel the tension in this one', 'that\'s the face of someone who knows',
    'these are the moments that last', 'this needs no caption',
    'poker has a look and this is it', 'moments like these don\'t get staged',
  ],

  // Controversy / scandal pool — for drama/scandal headlines (e.g. cheating, bans)
  controversy: [
    'if true, that\'s a big deal', 'poker doesn\'t need this',
    'the community deserves better than this', 'follow the evidence, not the noise',
    'this one\'s going to have some fallout', 'everyone saw something was off',
    'integrity matters in this game', 'not the first time something like this came up',
    'people knew. nobody said anything.', 'if half of what\'s being said is true, it\'s bad',
    'reputations take years to build', 'the poker world is small, things come out eventually',
  ],

  general: [
    'facts', '100%', 'real talk', 'same honestly', 'valid', 'W post',
    'true', 'i felt this', 'let\'s go', 'banger',
    'needed this', 'dead on', 'this hits', 'hard agree', 'say it louder',
    'exactly', 'not wrong', 'always', 'every time', 'preach', 'that\'s the one',
    'couldn\'t have said it better', 'this is why I follow this page', 'the truth',
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// QUESTION COMMENT POOLS
// Injected ~18% of the time to make comment sections feel authentically human.
// Real users ask questions — bots almost never do.
// ═══════════════════════════════════════════════════════════════════════════════
const QUESTION_COMMENTS = {
  sports: [
    'anyone watching this live?', 'did anyone see this coming?',
    'what\'s your take on that trade?', 'am I wrong or is this team legit now?',
    'how many games do they win from here?', 'anyone think they actually pull this off?',
    'does this change the playoff picture?', 'is this the best we\'ve seen from him this year?',
    'who beats them right now?', 'coach of the year conversation starting yet?',
    'anyone keeping track of how many records he\'s broken?',
  ],
  poker: [
    'anyone else catch this?', 'what would you have done there?',
    'who else was sweating that river?', 'is this the best hand of the year so far?',
    'anyone know what the stack sizes were?', 'would you have made that call?',
    'how often does this line actually work?', 'anyone seen a bigger pot this month?',
    'is this the best player in the world right now?',
  ],
  general: [
    'thoughts?', 'anyone else?', 'just me or?',
    'am I wrong here?', 'who else felt this?',
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// DM POOLS
// ═══════════════════════════════════════════════════════════════════════════════
const DM_PHRASES = {
  reply: [
    'yeah for sure', 'definitely', 'makes sense', 'for real', 'i hear that',
    'variance is brutal man', 'gotta keep grinding', 'tough spot', 'standard cooler', 
    'next hand', 'always happens at the worst time', 'just part of the game',
    'happens to the best of us', 'keep pushing', 'can\'t win them all',
    'sometimes the math doesn\'t matter', 'good luck at the tables today',
    'been there too many times to count', 'shake it off and keep playing'
  ],
  conclude: [
    'gotta head back to the tables, catch you later', 
    'back to the grind for me, gl', 
    'table is starting, talk later', 
    'good luck at the tables',
    'about to sit down for a session, ttyl',
    'anyway back to the tables',
    'gonna go punt a buy in, catch you later'
  ]
};

// ─── Pick with dedup ──────────────────────────────────────────────────────────
function pick(pool, profileId, salt = 0) {
  const phrase = pickFromPool(pool, profileId, salt);
  recordUsed(profileId, phrase);
  return phrase;
}

// ─── Detect content type from text ───────────────────────────────────────────
// FIXED: Use word-boundary guards to prevent 'beat' matching 'Lakers beat', etc.
function detectCategory(text = '') {
  const t = (text || '').toLowerCase();
  // Specific poker terms only (word-boundary aware)
  if (/\b(wsop|bracelet|world series of poker)\b/.test(t)) return 'tournament';
  if (/\b(bad beat|cooler|suck.?out|one.?outer|runner.?runner)\b/.test(t)) return 'bad_beat';
  if (/\bbluff\b/.test(t) && !/\bnfl|nba|nhl|mlb|soccer\b/.test(t)) return 'bluff';
  if (/\b(hero call|hero fold)\b/.test(t)) return 'soul_read';
  if (/\b(biggest pot|record pot|largest pot|all.time record|poker record)\b/.test(t)) return 'massive_pot';
  if (/\b(strategy|gto|solver|how to play|poker tips|study)\b/.test(t)) return 'educational';
  if (/\b(vlog|day in the life|grind vlog)\b/.test(t)) return 'vlog';
  if (/\b(high stakes poker|triton|super high roller)\b/.test(t)) return 'high_stakes';
  if (/\b(champion|final table|tournament win|mtt win)\b/.test(t)) return 'tournament';
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTEXT-AWARE TITLE INJECTION
// Extracts meaningful signals from the clip title / article headline and
// constructs a caption that actually references the content.
// ~60% of the time we use context; 40% we fall back to the category pool.
// This ensures variety while never feeling completely disconnected from the post.
// ═══════════════════════════════════════════════════════════════════════════════

// Known player names (first name OR last name match is enough)
const KNOWN_PLAYERS = [
  'Negreanu', 'Ivey', 'Hellmuth', 'Polk', 'Brunson', 'Esfandiari', 'Selbst',
  'Holz', 'Cada', 'Moneymaker', 'Chan', 'Hachem', 'Antonius', 'Dwan', 'Galfond',
  'Solberg', 'Rampage', 'Brad Owen', 'Neeme', 'Mariano', 'Wolfgang', 'Jaman',
  'Johnnie Vibes', 'Boski', 'Ryan Depaulo', 'Frankie', 'Doug', 'Berkey',
  'Persson', 'Reinkemeier', 'Kenney', 'Yockey', 'Aldemir', 'Koroknai',
  'Phil', 'Daniel', 'Tom', 'Ike', 'Uri', 'Biluzin',
];

// Known venues / shows
const KNOWN_VENUES = [
  { match: /hustler/i,      name: 'Hustler Casino Live' },
  { match: /bellagio/i,     name: 'Bellagio' },
  { match: /lodge/i,        name: 'the Lodge' },
  { match: /live at the bike/i, name: 'Live at the Bike' },
  { match: /triton/i,       name: 'Triton' },
  { match: /pokergo/i,      name: 'PokerGO' },
  { match: /high stakes poker/i, name: 'High Stakes Poker' },
  { match: /poker after dark/i,  name: 'Poker After Dark' },
  { match: /wynn/i,         name: 'Wynn' },
  { match: /aria/i,         name: 'Aria' },
  { match: /stones/i,       name: 'Stones' },
  { match: /wsop/i,         name: 'the WSOP' },
  { match: /wpt/i,          name: 'the WPT' },
  { match: /ept/i,          name: 'the EPT' },
  { match: /cgwc/i,         name: 'the CGWC' },
];

// Context-aware caption templates keyed by what was detected
// {{subject}} = player name or show/venue name
const CONTEXT_TEMPLATES = {
  player: [
    '{{subject}} in this one',
    'watching {{subject}} is always interesting',
    'that {{subject}} hand was something',
    'classic {{subject}} at the table',
    '{{subject}} knows what he\'s doing out there',
    '{{subject}} runs hot and cold like everyone else',
    'always something to learn from watching {{subject}}',
    '{{subject}} makes it look easy',
    'hard to argue with how {{subject}} played that',
    '{{subject}} doing {{subject}} things',
  ],
  venue: [
    '{{subject}} always delivers',
    'another one from {{subject}}',
    '{{subject}}, never a dull hand',
    'the action at {{subject}} never stops',
    '{{subject}} has been running wild lately',
    'if you\'re not watching {{subject}} you\'re missing out',
    '{{subject}} is where the real hands happen',
    'back at {{subject}}, back at it',
  ],
  concept: {
    bluff:       ['had to be a bluff. had to be.', 'the nerve on that bet', 'stone cold execution', 'run it and pray strategy', 'that sizing was a statement'],
    hero_call:   ['that\'s a hero call if I\'ve ever seen one', 'no way I make that call', 'the read was real', 'pure instinct', 'dialed in on that one'],
    full_house:  ['flopped a monster', 'river full house hits different', 'when the board gives you everything', 'flopped the world'],
    bad_beat:    ['brutal runout', 'the deck said no', 'one outer special', 'variance is a beast'],
    vlog:        ['the grind on camera is something else', 'raw look at the real game', 'day in the life stuff always hits', 'respect for documenting the grind'],
    wsop:        ['every WSOP hand matters at this stage', 'bubble pressure is different', 'deep run energy', 'WSOP is the standard'],
    day_final:   ['every chip counts late in a tournament', 'the pressure ramps up fast', 'this is what tournament poker looks like'],
    breakdown:   ['breaking it down hand by hand is how you get better', 'the analysis is always worth watching', 'street-by-street breakdowns are underrated'],
  }
};

/**
 * Extract context from a title string.
 * Returns { type: 'player'|'venue'|'concept'|null, value: string|null }
 */
function extractTitleContext(title) {
  if (!title || typeof title !== 'string' || title.length < 3) return { type: null, value: null };
  const t = title;

  // 1. Check for known players
  for (const p of KNOWN_PLAYERS) {
    if (new RegExp(`\\b${p}\\b`, 'i').test(t)) {
      return { type: 'player', value: p };
    }
  }

  // 2. Check for known venues/shows
  for (const v of KNOWN_VENUES) {
    if (v.match.test(t)) return { type: 'venue', value: v.name };
  }

  // 3. Check for key concepts
  if (/hero\s*call/i.test(t)) return { type: 'concept', value: 'hero_call' };
  if (/full\s*house/i.test(t)) return { type: 'concept', value: 'full_house' };
  if (/bluff/i.test(t)) return { type: 'concept', value: 'bluff' };
  if (/bad\s*beat|suck\s*out|cooler/i.test(t)) return { type: 'concept', value: 'bad_beat' };
  if (/vlog|day\s*\d/i.test(t)) return { type: 'concept', value: 'vlog' };
  if (/wsop|world\s*series/i.test(t)) return { type: 'concept', value: 'wsop' };
  if (/day\s*(\d+|final|2|3)/i.test(t)) return { type: 'concept', value: 'day_final' };
  if (/breakdown|analysis|hand history|street.by.street/i.test(t)) return { type: 'concept', value: 'breakdown' };

  return { type: null, value: null };
}

/**
 * Build a context-aware caption from the extracted title context.
 * Returns null if no useful context found (fallback to pool).
 */
function buildContextCaption(ctx, profileId) {
  if (!ctx || ctx.type === null) return null;

  const archetype = getArchetype(profileId);

  if (ctx.type === 'player') {
    const templates = CONTEXT_TEMPLATES.player;
    const h = getHorseHash(profileId);
    const template = templates[(h + Math.floor(Math.random() * 3)) % templates.length];
    const phrase = template.replace(/{{subject}}/g, ctx.value);
    recordUsed(profileId, phrase);
    return applyStyle(phrase, archetype);
  }

  if (ctx.type === 'venue') {
    const templates = CONTEXT_TEMPLATES.venue;
    const h = getHorseHash(profileId);
    const template = templates[(h + Math.floor(Math.random() * 3)) % templates.length];
    const phrase = template.replace(/{{subject}}/g, ctx.value);
    recordUsed(profileId, phrase);
    return applyStyle(phrase, archetype);
  }

  if (ctx.type === 'concept') {
    const pool = CONTEXT_TEMPLATES.concept[ctx.value];
    if (!pool) return null;
    const phrase = pool[Math.floor(Math.random() * pool.length)];
    recordUsed(profileId, phrase);
    return applyStyle(phrase, archetype);
  }

  return null;
}


// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL OUTPUT SANITIZER — strip chars that are BANNED from horse-generated text
// Em dash (—) is forbidden: it reads as formal/editorial, not human.
// Applied at every public export as a final safety net.
// ═══════════════════════════════════════════════════════════════════════════════
function sanitizeHorseOutput(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/\u2014/g, ',')   // em dash → comma (natural spoken rhythm)
    .replace(/  +/g, ' ')       // collapse double spaces left by removal
    .trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a post caption for a video clip.
 * No API calls, no cost. Deduplication built in.
 */
export function generatePostCaption(category: string, profileId: string, clipTitle: string = ''): string {
  // Null-guard: callers may pass explicit null
  const safeTitle = (clipTitle && typeof clipTitle === 'string') ? clipTitle : '';
  // 60% of the time: try to generate a title-aware, contextual caption
  if (safeTitle && Math.random() < 0.60) {
    const ctx = extractTitleContext(safeTitle);
    const contextCaption = buildContextCaption(ctx, profileId);
    // BUG-FIX: contextCaption early-return previously bypassed sanitizeHorseOutput
    if (contextCaption && contextCaption.trim().length >= 10) return sanitizeHorseOutput(contextCaption);
  }

  // Fallback: pick from category-appropriate phrase pool
  // SAFETY GUARD: If category is sports_highlight, NEVER fall back to massive_pot.
  // detectCategory() could match poker terms in a sports clip title (e.g. 'all in',
  // 'money', 'pot') and route to a poker pool. Always use sports_highlight as floor.
  const isSportsCategory = category === 'sports_highlight';
  const pool = POST_CAPTIONS[category] ||
               (!isSportsCategory ? POST_CAPTIONS[detectCategory(safeTitle)] : null) ||
               (isSportsCategory ? POST_CAPTIONS.sports_highlight : POST_CAPTIONS.massive_pot);

  const archetype = getArchetype(profileId);

  // Min-length guard: retry up to 3x to avoid trivially empty captions
  // NOTE: threshold is 5, not 10, to allow the very short 2-3 word sports entries ("nasty", "no way")
  let phrase = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = pick(pool, profileId);
    if (candidate && candidate.trim().length >= 5) { phrase = candidate; break; }
    if (!phrase || candidate.length > phrase.length) phrase = candidate || phrase;
  }

  // 20% chance: prefix with archetype flair (randomized pick, not always same word)
  // For sports content, block poker-specific and poker-hyperbole flairs
  if (archetype.flair.length > 0 && Math.random() < 0.20) {
    let flairPool = archetype.flair;
    if (isSportsCategory) {
      const blockedForSports = ['solver take', 'GTO note', 'range perspective', 'massive', 'huge', 'unreal', 'textbook', 'seen it', 'classic spot', 'idk', 'not convinced', 'questionable'];
      flairPool = archetype.flair.filter(f => !blockedForSports.includes(f));
    }
    if (flairPool.length > 0) {
      const flair = flairPool[Math.floor(Math.random() * flairPool.length)];
      phrase = `${flair}, ${phrase.toLowerCase()}`;
    }
  }

  return sanitizeHorseOutput(applyStyle(phrase, archetype));
}

/**
 * Generate a comment on a post.
 * No API calls, no cost. Deduplication + cross-horse post dedup built in.
 *
 * @param {string} commentType  - Pool key (sports, bad_beat, tournament, general, etc.)
 * @param {string} profileId    - Horse profile ID
 * @param {string} [postId]     - Optional post ID for cross-horse dedup
 */
export function generateComment(commentType: string, profileId: string, postId: string | null = null): string {
  const archetype = getArchetype(profileId);

  // Map commentType to question domain
  // controversy → poker questions (it's a poker platform context)
  const questionDomain = commentType === 'sports' ? 'sports'
    : (commentType === 'general' || commentType === 'photo') ? 'general'
    : 'poker'; // poker, video, bad_beat, bluff, tournament, controversy → poker questions
  if (Math.random() < 0.18 && QUESTION_COMMENTS[questionDomain]) {
    const qPool = QUESTION_COMMENTS[questionDomain];
    // Use deterministic pick + postId as extra salt to vary across horses on same post
    const postSalt = postId ? postId.split('').reduce((a, c) => a + c.charCodeAt(0), 0) : 0;
    const idx = (getHorseHash(profileId) + postSalt + qPool.length) % qPool.length;
    let qPhrase = qPool[idx];
    // Cross-horse dedup: try next candidates if this question was already used on this post
    for (let i = 0; i < qPool.length; i++) {
      const candidate = qPool[(idx + i) % qPool.length];
      if (!isAlreadyCommentedOnPost(postId, candidate)) { qPhrase = candidate; break; }
    }
    registerCommentOnPost(postId, qPhrase);
    recordUsed(profileId, qPhrase);
    // Use applyQuestionStyle (not applyStyle) — preserves the ? mark
    return sanitizeHorseOutput(applyQuestionStyle(qPhrase, archetype));
  }

  const pool = COMMENT_PHRASES[commentType] || COMMENT_PHRASES.general;

  // Cross-horse post dedup: pick a phrase not already used on this post by another horse
  let phrase = '';
  const postSalt = postId ? postId.split('').reduce((a, c) => a + c.charCodeAt(0), 0) : 0;
  const h = getHorseHash(profileId);
  for (let i = 0; i < pool.length; i++) {
    const candidate = pool[(h + postSalt + i) % pool.length];
    if (!isRecentlyUsed(profileId, candidate) && !isAlreadyCommentedOnPost(postId, candidate)) {
      phrase = candidate;
      break;
    }
  }
  // Fallback: use any available phrase even if used elsewhere
  if (!phrase) phrase = pick(pool, profileId, 1);

  registerCommentOnPost(postId, phrase);
  recordUsed(profileId, phrase);
  return sanitizeHorseOutput(applyStyle(phrase, archetype));
}

/**
 * Extract sports-specific signal from a news headline.
 * Returns { sport, signal } or null.
 */
function extractSportsContext(headline) {
  if (!headline) return null;
  const t = headline.toLowerCase();

  let sport = null;
  if (/\b(nba|basketball|lakers|celtics|warriors|lebron|curry|durant|knicks|bulls|heat|bucks|sixers|nets|cavs)\b/.test(t)) sport = 'nba';
  else if (/\b(nfl|football|chiefs|eagles|cowboys|patriots|49ers|bengals|ravens|bills|packers|mahomes|quarterback|qb|touchdown)\b/.test(t)) sport = 'nfl';
  else if (/\b(mlb|baseball|yankees|dodgers|red sox|mets|braves|astros|home run|pitcher|strikeout)\b/.test(t)) sport = 'mlb';
  else if (/\b(nhl|hockey|puck|rangers|bruins|penguins|oilers|lightning|power play)\b/.test(t)) sport = 'nhl';
  else if (/\b(mma|ufc|boxing|fight|knockout|submission|title fight|belt)\b/.test(t)) sport = 'combat';
  else if (/\b(soccer|mls|premier league|champions league|la liga|bundesliga|fifa|world cup|penalty)\b/.test(t)) sport = 'soccer';
  else if (/\b(golf|pga|masters|tiger|ryder cup|birdie|eagle)\b/.test(t)) sport = 'golf';
  else if (/\b(tennis|wimbledon|australian open|french open|serve)\b/.test(t)) sport = 'tennis';

  let signal = null;
  if (/\b(record|all.time|history|historic|most ever|never before)\b/.test(t)) signal = 'record';
  else if (/\b(wins|won|beat|beats|victory|defeats|clinch)\b/.test(t)) signal = 'win';
  else if (/\b(loses|lost|loss|eliminated|exit)\b/.test(t)) signal = 'loss';
  else if (/\b(injur|out for|hurt|sidelined|questionable|ruled out)\b/.test(t)) signal = 'injury';
  else if (/\b(draft|trade|signs|sign|free agent|contract|deal)\b/.test(t)) signal = 'transaction';
  else if (/\b(retire[sd]?|retirement|farewell|last game|final season)\b/.test(t)) signal = 'retirement';
  else if (/\b(championship|title|trophy|ring|playoff|series)\b/.test(t)) signal = 'championship';
  else if (/\b(stats|stat line|career high|season high|points|yards|goals)\b/.test(t)) signal = 'performance';

  return (sport || signal) ? { sport, signal } : null;
}

// Sports caption pools by signal type — contextually relevant reactions
const SPORTS_CAPTION_POOLS = {
  record: [
    'numbers like that don\'t happen often', 'the history books are being rewritten right now',
    'that record stood for a reason, now it doesn\'t', 'hard to put that kind of achievement into context',
    'nobody who was watching will forget this', 'generational stuff',
    'records exist to be broken. still wild when it happens.', 'that changes the conversation entirely',
    'stats don\'t lie and these stats are something else', 'you have to see that number to believe it',
  ],
  win: [
    'well deserved', 'that team is built for this', 'nobody gave them a shot and here we are',
    'the W was earned not given', 'executing at the right time is everything in sports',
    'the locker room energy after that must be something', 'that game had a lot to say',
    'statement game', 'the momentum is real now', 'squeezed that one out',
  ],
  loss: [
    'tough one to process', 'that one is going to sting for a while',
    'the season just got a lot more complicated', 'too many mistakes at the wrong time',
    'gotta bounce back fast', 'a loss like that changes the narrative',
    'hard to watch if you\'re a fan', 'happens to every team, timing is everything',
  ],
  injury: [
    'the worst part of any sport', 'hoping for a quick recovery',
    'timing couldn\'t be worse for that team', 'next man up mentality has to kick in',
    'a lot changes with this news', 'the season outlook just shifted significantly',
    'injuries are the one variable nobody can control',
  ],
  transaction: [
    'the front office is making moves', 'this changes the roster dynamic completely',
    'bold move to make this kind of deal', 'the league just got more interesting',
    'front office chess is its own sport', 'someone got a steal here',
    'the ripple effects from this are going to be felt', 'blockbuster',
  ],
  retirement: [
    'end of an era', 'nobody can take away what they accomplished',
    'careers like that don\'t come around often', 'the sport is different without them',
    'the highlights will hold up forever', 'a player\'s player',
    'the gap they leave behind is the best compliment you can give',
  ],
  championship: [
    'the stakes just got real', 'pressure separates the good from the great',
    'built for this moment', 'championship runs are something different',
    'every game feels different in the playoffs', 'legacy on the line',
    'one game, everything on it', 'the team that wants it more usually gets it',
  ],
  performance: [
    'that stat line is worth staring at', 'elite performance deserves to be recognized',
    'consistent at the highest level is harder than people realize',
    'the numbers back up everything the highlights show',
    'you can\'t guard that', 'that\'s what peak looks like',
    'if you watched that and weren\'t impressed something is wrong',
  ],
  nba: [
    'the league has been wild this season', 'nba basketball is must-watch right now',
    'the talent pool in this league is insane', 'nobody is safe in the west',
    'east is more competitive than people give it credit', 'playoff picture is getting interesting',
  ],
  nfl: [
    'sunday keeps delivering', 'nfl parity is wild this year',
    'the league never has a slow week', 'every game has a story',
    'coaching matters more than people admit', 'this season is going to the wire',
  ],
  mlb: [
    'baseball season is long but moments like this cut through',
    'the sport has a way of creating memories', 'anything can happen in october',
    'that\'s the beauty of baseball',
  ],
  combat: [
    'combat sports delivering again', 'you tune in for moments exactly like this',
    'the best fighters make it look like they were born for it',
    'fight game is unpredictable for a reason',
  ],
  soccer: [
    'beautiful game living up to the name', 'the sport produces moments like no other',
    'world class talent on display', 'the passion around this sport is unmatched',
  ],
  golf: [
    'golf has a way of humbling you at the worst time', 'the mental game in golf is everything',
    'a round like that doesn\'t come together without preparation',
  ],
  general_sports: [
    'this week in sports has been something else', 'hard to keep up with everything happening',
    'the sports world never slows down', 'athletes doing what they do at the highest level',
    'good time to be a sports fan honestly', 'the game keeps moving and so do the stories',
    'worth following closely if you care about where this is heading',
    'every season has a turning point. this might be one of them.',
    'the storylines this year have been unreal', 'hard to argue with what\'s happening here',
  ],
};

// Poker news caption pools — much richer than before
const POKER_NEWS_POOLS = {
  tournament: [
    'the field is going to be deep', 'tournament poker is something else at this level',
    'the prep that goes into playing this kind of event is underrated',
    'final table runs change careers', 'one of those events that keeps the whole community watching',
    'the name that wins this one will be talked about', 'circuit is heating up',
    'chip stacks are going to matter a lot here', 'one of the bigger events of the year',
  ],
  player_news: [
    'following this closely', 'the community takes notice when news like this drops',
    'names like that carry weight in the poker world', 'worth paying attention to',
    'the poker world never stops moving', 'someone\'s life just changed',
    'every pro has a story. this one has another chapter.',
    'big news out of the poker world today',
  ],
  strategy: [
    'this is the kind of content that actually improves your game',
    'took notes reading through this', 'the theory side of poker is underrated',
    'a lot of players skip the study phase. don\'t be that player.',
    'concepts like this don\'t become clear overnight', 'worth the time to sit with this one',
    'this changes how I think about that spot',
  ],
  industry: [
    'the poker world is always moving', 'something to keep an eye on',
    'bigger than it looks on the surface', 'the ecosystem around poker matters',
    'when the industry shifts, everyone feels it eventually',
    'changes like this take time to ripple through',
  ],
  general_poker: [
    'the scene keeps producing storylines', 'worth bookmarking this one',
    'good read for anyone following the game', 'the poker world is rarely quiet',
    'adds context to what\'s been happening lately', 'not surprised, still relevant',
    'the game evolves and the news evolves with it',
    'one of those stories that has legs', 'always more going on than the headline suggests',
    'poker news cycle never really stops', 'the sport keeps growing its own mythology',
  ],
  // Controversy / scandal pool — cheating allegations, bans, legal disputes
  controversy: [
    'if true, that\'s a big deal for the community',
    'poker doesn\'t need this kind of story',
    'the community deserves better than this',
    'follow the evidence, not the noise',
    'this one\'s going to have some fallout',
    'everyone saw something was off',
    'integrity matters in this game more than people admit',
    'not the first time something like this surfaced',
    'people knew. nobody said anything.',
    'reputations take years to build',
    'the poker world is small. things come out eventually.',
    'hard to know what\'s real until more facts come out',
  ],
};

/**
 * Generate a news-link caption from a headline.
 * Now extracts actual article signals for contextually relevant captions.
 * No API calls, no cost. Deduplication built in.
 */
export function generateNewsCaption(headline: string, profileId: string, newsType: string = 'poker'): string {
  const archetype = getArchetype(profileId);
  const safeHeadline = (headline && typeof headline === 'string') ? headline : '';

  let pool;

  if (newsType === 'sports') {
    // Extract sports-specific context from headline
    const sportsCtx = extractSportsContext(safeHeadline);
    if (sportsCtx) {
      const signalPool = sportsCtx.signal && SPORTS_CAPTION_POOLS[sportsCtx.signal];
      const sportPool = sportsCtx.sport && SPORTS_CAPTION_POOLS[sportsCtx.sport];
      pool = signalPool || sportPool || SPORTS_CAPTION_POOLS.general_sports;
    } else {
      pool = SPORTS_CAPTION_POOLS.general_sports;
    }
  } else {
    // CONTROVERSY PRE-CHECK: Run keyword scan BEFORE context extraction.
    // A headline like "Mike Postle Cheating Scandal" has a known player name AND
    // controversy keywords — without this guard, extractTitleContext fires first
    // and routes to the player template pool, bypassing the controversy pool entirely.
    const controversyTest = safeHeadline.toLowerCase();
    const isControversy = /\b(scandal|cheating|cheat|banned|ban|suspended|suspension|lawsuit|fraud|exposed|controversy|investigation|collusion)\b/.test(controversyTest);

    // Poker news — try context extraction (85% of the time) UNLESS it's a controversy headline
    // Short-circuit: skip extraction if headline is too short to yield meaningful context
    const wordCount = safeHeadline.trim().split(/\s+/).length;
    if (!isControversy && safeHeadline && wordCount >= 3 && Math.random() < 0.85) {
      const ctx = extractTitleContext(safeHeadline);
      const contextCaption = buildContextCaption(ctx, profileId);
      if (contextCaption && contextCaption.trim().length >= 10) return sanitizeHorseOutput(contextCaption);
    }

    // CONTROVERSY ABSOLUTE PRIORITY: If headline contains scandal keywords, go directly
    // to controversy pool — DO NOT run detectCategory (wsop/bracelet in headline would
    // otherwise hijack the route to POST_CAPTIONS.tournament before we check isControversy).
    if (isControversy) {
      pool = POKER_NEWS_POOLS.controversy;
    } else {
      // Category-aware poker pool selection (only for non-controversy headlines)
      const detected = detectCategory(safeHeadline);
      if (detected && POST_CAPTIONS[detected]) {
        pool = POST_CAPTIONS[detected];
      } else {
        const t = controversyTest; // already lowercased above
        if (/\b(wsop|wpt|world poker tour|ept|tournament|series|main event|bracelet|final table|deep run|heads.?up championship)\b/.test(t)) {
          pool = POKER_NEWS_POOLS.tournament;
        } else if (/\b(strategy|gto|solver|range|study|how to|tips|theory|deep dive)\b/.test(t)) {
          pool = POKER_NEWS_POOLS.strategy;
        } else if (/\b(regulation|legal|law|bill|legislation|license|market)\b/.test(t)) {
          pool = POKER_NEWS_POOLS.industry;
        } else if (/\b(player|pro|wins|cashes|result|bracelet|champion|finish|place|casino|live at|tonight|hustler|bellagio|lodge|aria|stones)\b/.test(t)) {
          pool = POKER_NEWS_POOLS.player_news;
        } else {
          pool = POKER_NEWS_POOLS.general_poker;
        }
      }
    }
  }

  let phrase = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = pick(pool, profileId, 2);
    if (candidate && candidate.trim().length >= 10) { phrase = candidate; break; }
    if (!phrase || candidate.length > phrase.length) phrase = candidate || phrase;
  }

  if (archetype.flair.length > 0 && Math.random() < 0.20) {
    let allowedFlairs = archetype.flair;
    if (newsType !== 'poker') {
      // Block ALL flairs that feel poker-specific OR too hyperbolic for sports news
      const blockedForSports = [
        'solver take', 'GTO note', 'range perspective',
        'massive', 'huge', 'unreal',
        'textbook', 'seen it', 'classic spot',
        'idk', 'not convinced', 'questionable',
      ];
      allowedFlairs = archetype.flair.filter(f => !blockedForSports.includes(f));
    } else if (pool === POKER_NEWS_POOLS.industry || pool === POKER_NEWS_POOLS.strategy || pool === POKER_NEWS_POOLS.general_poker) {
      // Even on poker news, don't prefix industry/strategy/general articles
      // with hype flairs like 'massive' or 'huge' — sounds odd on regulation or theory news
      const blockedForProse = ['massive', 'huge', 'unreal'];
      allowedFlairs = archetype.flair.filter(f => !blockedForProse.includes(f));
    } else if (pool === POKER_NEWS_POOLS.controversy) {
      // CRITICAL: Controversy/scandal headlines must NEVER get poker-analysis flair prefixes.
      // "GTO note, the poker world is small" reads as tone-deaf and bot-like.
      const blockedForControversy = [
        'solver take', 'GTO note', 'range perspective',
        'massive', 'huge', 'unreal', 'textbook', 'seen it', 'classic spot',
      ];
      allowedFlairs = archetype.flair.filter(f => !blockedForControversy.includes(f));
    }
    if (allowedFlairs.length > 0) {
      const flair = allowedFlairs[Math.floor(Math.random() * allowedFlairs.length)];
      phrase = `${flair}, ${phrase.toLowerCase()}`;
    }
  }

  return sanitizeHorseOutput(applyStyle(phrase, archetype));
}

/**
 * Generate a direct message reply.
 * Concludes the conversation if history is getting long.
 */
export function generateDMReply(historyLength: number, profileId: string): string {
  const isConcluding = historyLength >= 3;
  const pool = isConcluding ? DM_PHRASES.conclude : DM_PHRASES.reply;
  const archetype = getArchetype(profileId);
  const phrase = pick(pool, profileId, 3);
  return sanitizeHorseOutput(applyStyle(phrase, archetype));
}

/**
 * Seed a horse's memory from Supabase (call on startup/cron boot).
 * Prevents cross-session repeats.
 *
 * @param {string} profileId
 * @param {string[]} recentPhrases - Last 15 phrases from DB
 */
export function seedHorseMemory(profileId: string, recentPhrases: string[] = []): void {
  const mem = getHorseMemory(profileId);
  // Guard: Supabase may return null data — treat as empty
  const safe = Array.isArray(recentPhrases) ? recentPhrases : [];
  mem.lastUsed = safe
    .filter(p => p != null && typeof p === 'string' && p.trim().length > 0)
    .slice(0, MEMORY_DEPTH);
  for (const p of mem.lastUsed) mem.dayUsed.add(p.toLowerCase().trim());
}

