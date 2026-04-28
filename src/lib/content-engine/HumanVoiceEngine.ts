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
  // FIX 2026-04-28: Added Math.random() * 1000 to prevent batch-concurrent horses
  // (same timeBucket, same callN offset) from picking the same pool entry.
  // Duplicate posts like two horses both writing "The timing on that call was completely
  // different" back-to-back were caused by deterministic hash collision between horses
  // with close profile ID hashes. Per-call random spread eliminates same-batch duplicates.
  const timeBucket = Math.floor(Date.now() / (1000 * 60 * 60 * 4));
  const callN = nextPickOffset(profileId);
  const randSpread = Math.floor(Math.random() * 1000);
  const base = (h + timeBucket + salt + callN + randSpread) % pool.length;
  // Try every candidate in order, skip recently used
  for (let i = 0; i < pool.length; i++) {
    const candidate = pool[(base + i) % pool.length];
    if (!isRecentlyUsed(profileId, candidate)) return candidate;
  }
  // All used — rotate by callN to avoid always returning pool[0]
  return pool[(callN + randSpread) % pool.length];
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST CAPTION POOLS
// Each pool has short, medium, long entries mixed in to ensure structural variety.
// ═══════════════════════════════════════════════════════════════════════════════
const POST_CAPTIONS = {

  massive_pot: [
    // Real people reacting to a huge pot — punchy, surprised, invested
    'nah the pot size changed everything right there',
    'both of them felt it, you could see it',
    'I would have passed out at that bet sizing',
    'someone walked out of there either thrilled or sick',
    'chips went in fast and nobody hesitated',
    'when the stacks are deep the game gets interesting',
    'the variance in this game hits different at those stakes',
    'all in and I genuinely had no idea who had it',
    'two players both thinking they have the best hand',
    'one of those pots that decides the whole session',
    'couldn\'t have scripted that one any better honestly',
    'the money was already in before I even processed it',
    'this is literally why I love watching poker live',
    'nobody at that table was breathing normally after that',
    'that pot alone would change my month if I won it',
    'the kind of hand you remember at 3am for years',
    'once the money goes in there is nothing left to do',
    'I have been in a pot that size exactly once in my life',
  ],

  bluff: [
    // Reacting to a bold bluff — respect, disbelief, humor
    'nah he had absolutely nothing and still bet it',
    'no cards, no fear, all in on a story',
    'the nerve on that bet is genuinely unreal to me',
    'I would have mucked three streets earlier honestly',
    'he built the whole hand around a lie and it landed',
    'stone cold, never even flinched at that table',
    'villain folded the winner and the bluffer just sat there',
    'you can\'t teach that kind of composure at all',
    'if I try that exact play it gets snapped off immediately',
    'the bet sizing on the river was a whole statement',
    'went for it with nothing and walked away with everything',
    'I\'ve seen some ballsy plays but that one is up there',
    'the story he told over five streets was actually cohesive',
    'folded every time someone bets like that, and I would again',
    'imagine making that bet and knowing you have zero equity',
  ],

  bad_beat: [
    // Real pain. People who play poker know this feeling
    'nah the deck genuinely had it out for him that hand',
    'ran it perfectly and the river said absolutely not',
    'I have had that exact runout happen to me and it\'s awful',
    'math was right, cards did not care even a little',
    'this is the clip you send people when they ask why you\'re on tilt',
    'that one-outer is a special kind of cruel honestly',
    'he played it great and still lost, that\'s just poker',
    'the variance in this game is genuinely ruthless sometimes',
    'that call was correct and it still didn\'t matter',
    'sat with this clip for a minute before I could move on',
    'nobody deserves to run into that on the river',
    'sometimes the deck is just absolutely not on your side',
    'the look on his face when the river peeled is everything',
    'came into this world to feel pain apparently',
    'if this happened to me I would have needed a walk outside',
  ],

  soul_read: [
    // Genuine awe at a great read — this is when it clicks
    'he knew what he was up against before he even acted',
    'not a guess, not luck, that was a full live read',
    'I have watched this three times and still can\'t figure out how',
    'called it and looked completely comfortable doing it',
    'nah nobody makes that fold without seeing something real',
    'the look on his face said he had figured it out already',
    'that call took more courage than I personally have',
    'the read was there from the first bet honestly',
    'you don\'t make that play from a chart, that\'s just feel',
    'hero call is underselling it, that\'s a different level',
    'most people fold that hand at that stack depth, not him',
    'snapped it off like he had been waiting for that exact spot',
    'this is the kind of hand that follows you around for good reasons',
    'absolute conviction on a call that most of us never make',
    'people will be studying this clip in poker coaching sessions',
  ],

  table_drama: [
    // The tension when a table goes sideways — real reactions
    'the vibe at that table shifted immediately after that hand',
    'words were exchanged and none of them were friendly',
    'whatever happened next session must have been interesting',
    'you could feel the energy change through the screen',
    'everyone at that table felt it, nobody said anything useful',
    'the dealer was doing the most thankless job in that moment',
    'once the table tilts like that the whole dynamic is gone',
    'said what he said and clearly meant all of it',
    'takes a specific kind of moment to crack someone that composed',
    'the tension before the river was already at a ten',
    'some hands end the hand, some hands end the whole session',
    'nobody won that hand in any meaningful way after that exchange',
    'the energy in that room was completely different after this',
    'I have been at a table like that and you just want to leave',
  ],

  celebrity: [
    // Watching a known player — reverence, learning, fandom
    'still got it, watching him play is always worth it',
    'built the reputation one well-played hand at a time',
    'every time he sits down there is something to learn from it',
    'hard not to just stop and watch when he is in a hand',
    'the experience gap shows up in spots like this one',
    'came to watch and learned something immediately, as expected',
    'the way he reads the table is honestly a whole other thing',
    'legend for a reason and this hand is a good reminder of why',
    'I would love to know what was going through his head there',
    'you can tell he has seen this exact spot a thousand times',
    'studying hands like this is where the real improvement happens',
    'the composure alone is worth the watch on this one',
    'some players just have a feel for when to deviate and when not to',
    'this clip lives rent-free in my head in the best way',
  ],

  funny: [
    // Poker is genuinely hilarious sometimes
    'I cannot stop watching this, send help',
    'the poker gods were absolutely trolling that entire table',
    'nobody at the table knew what to do with themselves after that',
    'nah the reaction alone is worth watching multiple times',
    'that outcome was not in anyone\'s range of possibilities',
    'watched this like six times and it gets better each time',
    'I am crying, the timing of that is genuinely perfect',
    'every poker player in existence has been in this exact spot',
    'the game just does this sometimes and you have to respect it',
    'whoever planned for that outcome needs to explain their logic to me',
    'the table\'s reaction tells you everything you need to know',
    'this is the clip I send when someone asks me to explain poker',
    'if that happened at my home game we would still be talking about it',
  ],

  educational: [
    // Actually useful content — engaged and curious
    'rewatched this twice to catch the sizing pattern, worth it',
    'the spot most players miss is right there on the turn',
    'genuinely explains why position matters more than most people admit',
    'adding this one to my mental database of spots to study',
    'so many players get this exact decision completely wrong',
    'paused it before the river to think through what I would do',
    'the stack depth context is what makes this hand worth studying',
    'this is the kind of content that actually improves your game',
    'the way he constructs his range on the flop is the whole lesson here',
    'spent ten minutes on this one spot, learned something real',
    'most coaching content glosses over hands like this one, glad it\'s here',
    'the river decision alone has kept me thinking about it for a day',
    'breaks it down in a way that finally made it click for me',
    'range advantage doing all the work and this is a good example',
  ],

  vlog: [
    // Following someone\'s poker journey — real and relatable
    'this is what a real session actually looks like, respect the honesty',
    'the swings in this game never get easier to watch from the outside',
    'documenting the grind honestly is harder than it looks',
    'real talk, most people would have shut the camera off after that',
    'this is the stuff nobody shows you when they talk about poker life',
    'the variance hits differently when you are watching someone live it',
    'grinding long sessions requires something most people do not have',
    'the mental side of this game never gets talked about enough',
    'raw look at what actually goes into playing poker seriously',
    'you never see content this honest from people at this level',
    'keeps coming back to it even after tough sessions, that matters',
    'the lifestyle looks easy from the outside and is anything but',
    'logged more hands this week than most people do in a year',
  ],

  tournament: [
    // Tournament pressure is a whole different thing
    'ICM pressure at this stage is a completely different game',
    'deep run energy is something you can feel through the screen',
    'one chip and a chair is not a saying, it is a lifestyle',
    'the field was brutal and they are still here, respect that',
    'shove or fold decisions hit different when the money is real',
    'nobody sleeps well during a deep tournament run and it shows',
    'made it to this point playing great, do not stop now',
    'final table spots cost years of work and this is the proof',
    'the bubble is the most stressful twenty minutes in poker honestly',
    'late registration debate aside, being here is what matters',
    'watching someone navigate ICM well is genuinely satisfying to see',
    'nah this level of focus is not something most people can access',
    'every orbit at this stage means something completely different',
  ],

  high_stakes: [
    // Big games, elite players — awe and respect
    'the numbers being moved around this table are not small',
    'mistakes at this level show up in the results immediately',
    'different game at these stakes, the pressure is on every single decision',
    'nobody at this table is guessing, not even close',
    'the bet sizing alone tells you these players know what they are doing',
    'I can feel the pressure through the screen honestly',
    'the caliber at this table makes every hand worth watching carefully',
    'played at half these stakes once and still think about it',
    'soft spots do not exist in games like this one',
    'watching elite players mix it up is genuinely its own thing',
    'the mental game becomes the whole game at stakes like this',
    'respect the risk they are taking sitting down in this lineup',
  ],

  // ── Sports highlight video captions (used when clipType === 'sports') ──────────
  sports_highlight: [
    // Very short — punchy reactions
    'bro what', 'nah that\'s crazy', 'no way', 'ice cold',
    'come on now', 'wild', 'stop it',
    // Short
    'that was genuinely filthy', 'I would never recover from that',
    'did not see that coming at all', 'highlight of the whole week',
    'nobody touches him when he is locked in',
    // Medium
    'not many people on earth can do what he just did there',
    'that play changes how everyone thinks about this game',
    'the athleticism here is honestly hard to process',
    'the best players make it look easy and it is absolutely not easy',
    'whole arena felt that one at the same time',
    'the footwork alone makes this worth watching five more times',
    'built different and this is the proof right here',
    'you can practice that your whole life and still not pull it off',
    // Longer
    'plays like that do not happen without years of unglamorous work behind them',
    'whoever was guarding that man was in a genuinely impossible position',
    'the timing on that was so perfect it almost looks scripted',
    'hard to watch this and not appreciate how rare this level actually is',
    'this is exactly why you never leave before the final whistle',
    'the crowd reaction said everything that needed to be said right there',
    'that sequence frame by frame would make an incredible breakdown video',
    'the gap between good and elite becomes obvious in moments exactly like this',
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
    'brutal runout, nothing you can do about that one', 'that one hurts to watch twice', 'been there too many times, still stings',
    'variance is real and it hit hard right there', 'the deck had it out for him that hand',
    'played it perfectly right up until the deck lied', 'oof, that runout is criminal',
    'one-outers are a special kind of pain in this game', 'the math was right, the cards just disagreed.',
    'next session, shake it off and keep going', 'that kind of thing sticks with you a while',
    'nothing to do but move on and remember the math', 'happened to me last week, still thinking about it.',
    'awful runout, absolutely nothing you can do.', 'that is just poker doing what poker does',
  ],

  bluff: [
    'no cards needed and he knew it', 'that took nerve most players do not have',
    'the sizing was a statement, not a question',
    'he had to fold there honestly, no other choice', 'stone cold at the table, never flinched',
    'respect for the execution on that one', 'fearless play in a spot that mattered',
    'risky spot, worth it in the end',
    'the read was there long before the shove happened', 'everyone at the table knew it but nobody could move',
  ],

  tournament: [
    'ICM nightmare spot, no good options there', 'the bubble pressure is genuinely brutal to handle',
    'chip leader playing it exactly right in that spot',
    'final table spots do not come cheap or free', 'shove range widens significantly near the money',
    'field was tough and they still made it work', 'deep run incoming if they keep playing like this',
    'tournament poker requires a completely different mental gear',
  ],

  strategy: [
    'the sizing tells the whole story here', 'think about it from a range perspective first',
    'EV is all that matters in the long run',
    'textbook spot, could not be cleaner than that',
    'solver would have a different answer but this works too',
    'position is doing almost everything in this hand', 'the math checks out if you run it',
    'good example of when to deviate from the chart entirely',
  ],

  session_report: [
    'solid session, that result is well earned', 'the grind pays off when you stay patient',
    'always good to book a winning session', 'keep stacking chips and staying focused',
    'the hours you put in show up in the results', 'nice profit, build on that momentum',
    'sessions like that are what keep you going back', 'congrats on the run, stay focused',
  ],

  grind: [
    'respect the process, it pays off eventually', 'putting in volume when others are sleeping',
    'every hand counts over a long session', 'outwork the field and the results follow',
    'the grind honestly never stops for real players', 'sessions add up to something real eventually',
    'dedication to the game is genuinely real here', 'the work shows up in the results eventually',
  ],

  variance: [
    'variance is a beast that hits everyone eventually', 'the long run sorts it all out for real',
    'standard deviation showing up in full force right now', 'the swings are just part of the game',
    'keep playing your game and the math catches up', 'downswings always end, yours will too eventually.',
    'trust the math even when the cards disagree with you',
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
    'watching {{subject}} is always a good use of time',
    '{{subject}} making it look easy again',
    'nah {{subject}} cooked right there',
    '{{subject}} doing exactly what {{subject}} does',
    'I watch every {{subject}} hand I can find honestly',
    'hard to argue with how {{subject}} played that one',
    'the {{subject}} read was already in by the turn honestly',
    '{{subject}} in this spot is exactly what I came to see',
    'learned something from watching {{subject}} do this',
    'love or hate the style, {{subject}} knows what he is doing',
  ],
  venue: [
    '{{subject}} always delivers content worth watching',
    'another wild one from {{subject}}',
    '{{subject}} never has a dull hand, I will give them that',
    'the action at {{subject}} is just different honestly',
    '{{subject}} has been running wild this month',
    'if you are not watching {{subject}} you are genuinely missing out',
    '{{subject}} is where the hands people talk about actually happen',
    'back at {{subject}} and already it is interesting',
  ],
  concept: {
    bluff:      ['nah he had nothing and bet it anyway, respect', 'the nerve to run that through five streets is real', 'zero cards, full commitment, walked away with it', 'that sizing was a statement and the villain believed it', 'put together a story and they bought every word'],
    hero_call:  ['that call took something most people do not have', 'no way I make that call there, genuinely no way', 'the read was in before he even tanked', 'called it and looked completely comfortable doing it', 'that is a different level of conviction right there'],
    full_house:  ['flopped a monster and got paid for it', 'river full house in that spot hits different', 'the board gave him everything and he used all of it', 'flopped the world and milked every single street'],
    bad_beat:    ['nah the deck genuinely had it out for him', 'ran it perfectly and the river said no', 'one outer with the money in, that is special cruelty', 'variance is a beast and it showed up today'],
    vlog:        ['this is what the grind actually looks like, respect it', 'raw look at the real game, not the highlight version', 'day in the life stuff hits different when it is honest', 'documenting this honestly is harder than it looks'],
    wsop:        ['every WSOP hand carries real weight, you can feel it', 'bubble pressure at the World Series is just different', 'deep run energy is something you feel through the screen', 'WSOP is the standard and this hand shows why'],
    day_final:   ['every chip at this stage means something different', 'the pressure at a final table is something else entirely', 'this is exactly what high stakes tournament poker looks like'],
    breakdown:   ['breaking it down like this is how you actually get better', 'this breakdown is more useful than a week of random hands', 'street-by-street is underrated as a study format'],
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
  let out = text
    .replace(/\u2014/g, ',')   // em dash → comma
    .replace(/\u2013/g, ',')   // en dash → comma
    .replace(/ - /g, ', ')     // hyphen-as-separator → comma (preserves compound words like 'one-outer')
    .replace(/  +/g, ' ')      // collapse double spaces
    .trim();
  // RULE 1: First letter ALWAYS capitalized — cell phone auto-cap standard.
  if (out.length > 0 && out[0] !== out[0].toUpperCase()) {
    out = out[0].toUpperCase() + out.slice(1);
  }
  // Restore poker/sports acronyms lowercased by applyStyle() all_lower archetype.
  // e.g. 'icm' → 'ICM', 'wsop' → 'WSOP', 'gto' → 'GTO', 'nba' → 'NBA'
  const ACRONYMS = ['ICM', 'GTO', 'WSOP', 'EV', 'MTT', 'SNG', 'NLH', 'PLO', 'BTN', 'UTG', 'NBA', 'NFL', 'MLB', 'NHL', 'UFC', 'MMA', 'ESPN', 'MVP', 'NGL'];
  for (const acr of ACRONYMS) {
    out = out.replace(new RegExp(`\\b${acr.toLowerCase()}\\b`, 'gi'), acr);
  }
  return out;
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

  // Pick initial phrase
  let phrase = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = pick(pool, profileId);
    if (candidate && candidate.trim().length >= 4) { phrase = candidate; break; }
    if (!phrase || candidate.length > phrase.length) phrase = candidate || phrase;
  }

  // RULE 2: Minimum 6 words per caption.
  // Loop with different salts until the combined phrase is genuinely ≥6 words.
  // Single-attempt logic failed: concatenating two short phrases ('brutal, oof') still < 6.
  for (let padSalt = 77; padSalt <= 477 && phrase.trim().split(/\s+/).filter(Boolean).length < 6; padSalt += 100) {
    const extra = pick(pool, profileId, padSalt);
    if (extra && extra !== phrase && extra.trim().length > 3) {
      const base = phrase.replace(/[.!?,;]+$/, '').trim();
      const tail = extra.replace(/[.!?,;]+$/, '').trim().toLowerCase();
      phrase = `${base}, ${tail}`;
    }
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
    if (candidate && candidate.trim().length >= 4) { phrase = candidate; break; }
    if (!phrase || candidate.length > phrase.length) phrase = candidate || phrase;
  }

  // RULE 2: Minimum 6 words per news caption — same hardened loop.
  for (let padSalt = 88; padSalt <= 488 && phrase.trim().split(/\s+/).filter(Boolean).length < 6; padSalt += 100) {
    const extra = pick(pool, profileId, padSalt);
    if (extra && extra !== phrase && extra.trim().length > 3) {
      const base = phrase.replace(/[.!?,;]+$/, '').trim();
      const tail = extra.replace(/[.!?,;]+$/, '').trim().toLowerCase();
      phrase = `${base}, ${tail}`;
    }
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

