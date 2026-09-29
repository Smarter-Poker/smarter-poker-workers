/**
 * VoiceWriter: the one place a horse's published words are produced.
 *
 * Ties the four Phase 2 pieces together so no route has to know the order:
 *
 *   PostBrief   what the thing IS
 *   StyleSheet  how this horse writes
 *   Composer    a sentence about that thing, in that style
 *   ContentLedger  has anyone said this lately
 *   FriendGraph    is there a friend worth tagging, and why
 *
 * Two guarantees enforced here, both of them Dan's words:
 *
 *   RELEVANCE. Nothing publishes below Composer.RELEVANCE_FLOOR. Drafts are
 *   retried with new variant seeds first, and the count of retries and floor
 *   misses is returned so a run can report how often the writer struggled.
 *
 *   FRESHNESS. Every draft is checked against horse_phrase_ledger before it
 *   goes out, and recorded after. Phase 1 proved the ledger is the only thing
 *   that actually stops repeats.
 *
 * The model layer is deliberately absent rather than stubbed: there is no
 * working key on the VM (checked 2026-09-05, XAI_API_KEY is rejected by the
 * provider), and a half-wired model call that silently fails is worse than
 * none. When a key exists, `ModelWriter` slots in at the marked point and
 * everything here stays as its fallback.
 */
import { briefForAsset, briefForPost, summarise, isUninformativeTitle, type PostBrief, type BriefSource } from './PostBrief.js';
import { styleSheetFor, styleId, describeStyle, sentenceKeys, type StyleSheet } from './StyleSheet.js';
import {
  composeCaption,
  composeComment,
  composeReply,
  relevanceOf,
  RELEVANCE_FLOOR,
} from './Composer.js';
import { normalizePhrase, phraseRecentlyUsed, phraseUsedOnPost, recentFrameKeys } from './ContentLedger.js';
import { areFriends, tagCandidateFor, renderTag, type FriendCandidate } from './FriendGraph.js';
import { fleetHash } from './FleetScheduler.js';
import { getSupabase } from '../supabase.js';
import { pickHandStory, pickSessionStory } from './HandStory.js';
import { lineFor, briefForSpokenHand } from './HandVoice.js';
import { sessionLineFor, sessionGroup, briefForSpokenSession } from './SessionVoice.js';

export interface WrittenText {
  text: string;
  brief: PostBrief;
  style: StyleSheet;
  relevance: number;
  grounding: string[];
  /** How many drafts were thrown away before this one. */
  attempts: number;
  /** True when we published below the floor because nothing better existed. */
  belowFloor: boolean;
  /** True when the ledger had seen every draft we tried. */
  stale: boolean;
  /** The friend tagged, if any. */
  tagged?: { alias: string; reason: string };
  /**
   * For grounded posts: the sentence skeleton used, so the publisher can
   * ledger it once the post actually exists. A draft that never publishes
   * must not consume a frame.
   */
  frameKey?: string;
  /**
   * True when the brief came out of post_briefs rather than being derived
   * here. The caller must NOT write it back: loadBrief() sanitises on read,
   * and persisting that sanitised copy makes the downgrade permanent and
   * compounding - a brief that loses a little confidence on every comment
   * ends up describing nothing.
   */
  briefWasStored?: boolean;
  /** Which separately-approved grounded mode produced this draft. */
  groundedKind?: 'hand' | 'session';
  /** Unstyled meaning for same-post semantic de-duplication. */
  semanticKey?: string;
  /**
   * Why nothing was written, when the reason is known: 'reply_ungrounded'
   * (the incoming comment raised nothing a reply can answer about),
   * 'echoes_post' (every usable draft repeated a sentence already on the
   * post), 'post_thread_unreadable' (the post's comments could not be read,
   * so novelty could not be proven). Callers count it; they never publish on it.
   */
  skipReason?: string;
}

const MAX_DRAFTS = 6;

/**
 * Draft, check, redraft. Shared by captions and comments so both obey the
 * same two gates.
 */
async function writeGated(
  make: (variant: string) => { text: string; relevance: number; grounding: string[]; semanticKey?: string; skip?: string },
  brief: PostBrief,
  style: StyleSheet,
  horseId: string,
  postId?: string,
  echoes?: (text: string) => boolean,
): Promise<Omit<WrittenText, 'brief' | 'style'>> {
  let best: { text: string; relevance: number; grounding: string[]; semanticKey?: string } | null = null;
  let attempts = 0;
  let sawFresh = false;
  let echoed = 0;

  for (let i = 0; i < MAX_DRAFTS; i++) {
    attempts = i + 1;
    const draft = make(String(i));
    // The composer refused on purpose (a reply with nothing to answer). The
    // same input gives the same answer, so report why instead of redrafting.
    if (draft.skip) {
      return { text: '', relevance: 0, grounding: [], attempts, belowFloor: false, stale: false, skipReason: draft.skip };
    }
    if (!draft.text) continue;
    if (!best || draft.relevance > best.relevance) best = draft;

    if (draft.relevance < RELEVANCE_FLOOR) continue;
    // Any sentence the post or a comment under it already said (P2C-05).
    if (echoes && echoes(draft.text)) {
      echoed++;
      continue;
    }
    if (draft.semanticKey && postId && await phraseUsedOnPost(draft.semanticKey, postId)) continue;
    if (draft.semanticKey && !postId && await phraseRecentlyUsed(draft.semanticKey, horseId)) continue;
    const norm = normalizePhrase(draft.text);
    if (await phraseRecentlyUsed(norm, horseId)) continue;

    sawFresh = true;
    return {
      text: draft.text,
      relevance: draft.relevance,
      grounding: draft.grounding,
      semanticKey: draft.semanticKey,
      attempts,
      belowFloor: false,
      stale: false,
    };
  }

  // Nothing cleared both gates. Do not publish filler, below-floor text, or
  // a repeated sentence. A missed slot is recoverable; low-quality content
  // in a player's feed is not.
  const fallback = best ?? { text: '', relevance: 0, grounding: [], semanticKey: undefined };
  return {
    text: '',
    relevance: fallback.relevance,
    grounding: fallback.grounding,
    semanticKey: fallback.semanticKey,
    attempts,
    belowFloor: fallback.relevance < RELEVANCE_FLOOR,
    stale: !sawFresh && fallback.relevance >= RELEVANCE_FLOOR,
    skipReason: echoed > 0 ? 'echoes_post' : undefined,
  };
}

export interface AuthorHorse extends FriendCandidate {
  name?: string;
}

/**
 * A caption for something this horse is about to post.
 * `fleet` is only needed for tagging; pass an empty array to skip it.
 */
export async function writeCaption(
  horse: AuthorHorse,
  asset: { kind: 'video' | 'link'; title?: string | null; source?: string | null; domainHint?: 'poker' | 'sports'; sportHint?: string | null },
  fleet: AuthorHorse[] = [],
): Promise<WrittenText> {
  const brief = briefForAsset(asset);
  const style = styleSheetFor(horse.profile_id);
  const core = await writeGated(
    (variant) => composeCaption(brief, style, variant),
    brief,
    style,
    horse.profile_id,
  );

  const out: WrittenText = { ...core, brief, style };

  // Tagging: only with a reason, at most one per post, and only ever a horse.
  if (out.text && style.tagRate > 0 && fleet.length) {
    const seed = `${horse.profile_id}:${brief.title}`;
    const roll = (fleetHash(seed, 'tagroll') % 100) / 100;
    if (roll < style.tagRate) {
      const cand = tagCandidateFor(horse, fleet, { domain: brief.domain, concepts: brief.concepts, sport: brief.sport }, seed);
      if (cand?.friend.alias) {
        const lead = style.lexicon.tags[fleetHash(seed, 'taglead') % style.lexicon.tags.length]!;
        const tag = renderTag(cand.friend.alias, lead);
        if (tag) {
          out.text = `${out.text}\n\n${tag}`;
          out.tagged = { alias: cand.friend.alias, reason: cand.reason };
        }
      }
    }
  }

  return out;
}

/**
 * A story: the horse's own short thought, seeded by a topic.
 *
 * Stories were the last route on the old engine (measured 2026-09-06): video
 * stories drew from the caption pools and text stories were 15 fixed
 * sentences, 48 fires a day. The seed still supplies the subject, but the
 * sentence is composed and styled like everything else, so the 974 style
 * sheets and the phrase ledger apply here too.
 */
export async function writeStory(
  horse: AuthorHorse,
  seedTopic: string,
  domainHint: 'poker' | 'sports' = 'poker',
): Promise<WrittenText> {
  const brief = briefForAsset({ kind: 'text', title: seedTopic, source: null, domainHint });
  const style = styleSheetFor(horse.profile_id);
  const core = await writeGated(
    (variant) => composeCaption(brief, style, variant),
    brief,
    style,
    horse.profile_id,
  );
  return { ...core, brief, style };
}

/**
 * A post about the poker this horse actually played.
 *
 * Phase 3. Tried before any clip or article, because a hand is the only
 * source that cannot repeat and cannot be about nothing: two horses did not
 * play the same hand. Returns null when the horse has nothing worth telling
 * (a quiet week, or only trivial pots), and the caller falls back to the
 * shared media pools.
 *
 * Hands and sessions are separate ways of posting with separate approval
 * (grounded_hand, grounded_session); each branch runs only when the caller
 * passes its own mode's decision as exactly `true`. Hands are spoken by
 * HandVoice and days by SessionVoice, each of which refuses any sentence the
 * row and its action log do not support. The freshness ledger still applies:
 * a horse should not tell the same line twice.
 */
export async function writeGrounded(
  horse: AuthorHorse,
  // Fails closed. The only caller passes the horse_post_modes decisions; a
  // caller that forgets them must not get an unapproved way of posting.
  allowed: { hand: boolean; session: boolean } = { hand: false, session: false },
): Promise<WrittenText | null> {
  // Every read below can fail, and no failure may turn into a post: an error
  // anywhere means this horse says nothing in this slot.
  try {
    const style = styleSheetFor(horse.profile_id);

    if (allowed?.hand === true) {
      const hand = await pickHandStory(horse.profile_id);
      if (hand) {
        // HandVoice (the Phase 3 replacement). The hand is SPOKEN, never
        // printed, and every claim about the action comes from the action
        // log (HandStory's `play`). It deliberately does NOT go through
        // StyleSheet.render, whose per-horse openers and closers are what put
        // "look" and "nah" in front of the rejected posts. The old
        // composeHandPost is not reachable from here.
        //
        // The frame ledger is shared with the rest of the fleet: a frame
        // another horse used in this category inside FRAME_GLOBAL_HOURS is
        // skipped, and an exhausted pool is silence.
        const exclude = new Set(await recentFrameKeys('voice', hand.category));
        const seed = `${horse.profile_id}:h:${hand.handId}`;
        for (let i = 0; i < MAX_DRAFTS; i++) {
          const spoken = lineFor(hand, seed, exclude);
          if (!spoken) break;
          if (await phraseRecentlyUsed(normalizePhrase(spoken.text), horse.profile_id)) {
            exclude.add(spoken.key);
            continue;
          }
          return {
            text: spoken.text,
            brief: briefForSpokenHand(hand),
            style,
            relevance: 1,
            grounding: [`hand:${hand.handId}`, `category:${hand.category}`, spoken.key],
            attempts: i + 1,
            belowFloor: false,
            stale: false,
            frameKey: spoken.key,
            groundedKind: 'hand',
          };
        }
      }
    }

    if (allowed?.session === true) {
      const session = await pickSessionStory(horse.profile_id);
      if (session) {
        // SessionVoice: the day said as a player says it. No big blinds, no
        // hand count, no StyleSheet filler. The old composeSessionPost is not
        // reachable from here.
        const exclude = new Set(await recentFrameKeys('sessionvoice', sessionGroup(session)));
        const seed = `${horse.profile_id}:s:${session.day}:${session.variant}:${session.format}`;
        for (let i = 0; i < MAX_DRAFTS; i++) {
          const spoken = sessionLineFor(session, seed, exclude);
          if (!spoken) break;
          if (await phraseRecentlyUsed(normalizePhrase(spoken.text), horse.profile_id)) {
            exclude.add(spoken.key);
            continue;
          }
          return {
            text: spoken.text,
            brief: briefForSpokenSession(session),
            style,
            relevance: 1,
            grounding: [`session:${session.day}`, `variant:${session.variant}`, `format:${session.format}`, spoken.key],
            attempts: i + 1,
            belowFloor: false,
            stale: false,
            frameKey: spoken.key,
            groundedKind: 'session',
          };
        }
      }
    }
  } catch (e) {
    console.warn('[voice] grounded draft skipped:', e instanceof Error ? e.message : String(e));
    return null;
  }

  return null;
}

/**
 * The brief recorded when a post was published, if there is one.
 *
 * This is the whole reason post_briefs exists. A horse's own video post
 * carries no link_title, so deriving a brief from the post row means
 * deriving it from the author's caption - and a caption is commentary, not
 * subject. The publisher already knew the clip's real title, channel and
 * concepts and wrote them down; a commenter should read that rather than
 * guess from the sentence above it.
 */
export async function loadBrief(postId: string | undefined): Promise<PostBrief | null> {
  if (!postId) return null;
  try {
    const { data, error } = await getSupabase()
      .from('post_briefs')
      .select('*')
      .eq('post_id', postId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as Record<string, unknown>;
    const storedTitle = (row.title as string) ?? '';
    const storedSource = (row.source as string) ?? undefined;
    const storedKind = (row.kind as PostBrief['kind']) ?? 'text';
    // Rows written before a title rule tightened still carry what that rule
    // now rejects: post_briefs from 2026-09-05 hold "Bleacher Report NBA NBA
    // Clip" as a topic and "Keyboard" as a person. A cache must never make
    // the engine dumber than deriving fresh would, so the same test is
    // applied on the way out.
    //
    // ONLY to briefs that came from somebody else's media. isUninformative-
    // Title asks whether a SCRAPED title says anything, and its yardstick is
    // words longer than two letters - so "AA on Qc 8s Qs 9c 9d", a title this
    // engine wrote itself out of a settled hand, scored zero informative
    // words and every grounded post was downgraded to 0.35 the first time
    // anybody commented on it (measured live 2026-09-06). A hand title has no
    // scraper between us and it; there is nothing to distrust.
    const junk = storedKind !== 'hand' && isUninformativeTitle(storedTitle, storedSource);
    return {
      postId,
      kind: storedKind,
      domain: (row.domain as PostBrief['domain']) ?? 'general',
      sport: (row.sport as PostBrief['sport']) ?? undefined,
      title: (row.title as string) ?? '',
      source: (row.source as string) ?? undefined,
      people: junk ? [] : ((row.people as string[]) ?? []),
      teams: (row.teams as string[]) ?? [],
      concepts: (row.concepts as string[]) ?? [],
      amounts: (row.amounts as string[]) ?? [],
      topic: junk ? undefined : ((row.topic as string) ?? undefined),
      tone: (row.tone as PostBrief['tone']) ?? 'neutral',
      isQuestion: Boolean(row.is_question),
      confidence: junk ? Math.min(Number(row.confidence ?? 0), 0.35) : Number(row.confidence ?? 0),
      // De-duplicated: this row is read and written back on every comment,
      // so a plain append grows the array in the database forever.
      builtFrom: [...new Set([...(((row.built_from as string[]) ?? [])), 'post_briefs'])],
    };
  } catch (e) {
    console.warn('[voice] brief read failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

/** A comment on somebody else's post, written after reading it. */
export async function writeComment(
  horse: AuthorHorse,
  post: BriefSource,
): Promise<WrittenText> {
  const stored = await loadBrief(post.postId);
  const brief = stored ?? briefForPost(post);
  const style = styleSheetFor(horse.profile_id);
  // Everything already said on this post: the text above it and every comment
  // under it. 13 of 35 harness comments restated a sentence of the caption
  // they sat under (p2-voice-c, 2026-09-21). If the thread cannot be read we
  // cannot prove the comment is new, so the horse stays quiet (fail closed).
  const said = await sentencesSaidOn(post);
  if (!said) {
    return {
      text: '',
      relevance: 0,
      grounding: [],
      attempts: 0,
      belowFloor: false,
      stale: false,
      brief,
      style,
      briefWasStored: Boolean(stored),
      skipReason: 'post_thread_unreadable',
    };
  }
  const core = await writeGated(
    (variant) => composeComment(brief, style, variant),
    brief,
    style,
    horse.profile_id,
    post.postId,
    (text) => sentenceKeys(text).some((k) => said.has(k)),
  );
  return { ...core, brief, style, briefWasStored: Boolean(stored) };
}

/** Most comments one post can carry before we stop trying to read them all. */
const THREAD_READ_MAX = 5000;
const THREAD_PAGE = 1000;

/**
 * Sentence keys of everything already said on a post, or null when that
 * cannot be established. Paged, because PostgREST returns at most 1,000 rows
 * per request and a truncated read would look exactly like a complete one.
 */
async function sentencesSaidOn(post: BriefSource): Promise<Set<string> | null> {
  const said = new Set<string>(sentenceKeys(post.content ?? ''));
  if (!post.postId) return said;
  try {
    const supa = getSupabase();
    for (let from = 0; from < THREAD_READ_MAX; from += THREAD_PAGE) {
      const { data, error } = await supa
        .from('social_comments')
        .select('content')
        .eq('post_id', post.postId)
        .order('created_at', { ascending: true })
        .range(from, from + THREAD_PAGE - 1);
      if (error) {
        console.warn('[voice] thread read failed:', error.message);
        return null;
      }
      const rows = (data ?? []) as Array<{ content?: string | null }>;
      for (const row of rows) for (const k of sentenceKeys(row.content ?? '')) said.add(k);
      if (rows.length < THREAD_PAGE) return said;
    }
    // More comments than we will read: novelty cannot be proven.
    return null;
  } catch (e) {
    console.warn('[voice] thread read threw:', e instanceof Error ? e.message : e);
    return null;
  }
}

/** A reply to a specific incoming comment. Short by design. */
export async function writeReply(
  horse: AuthorHorse,
  post: BriefSource,
  incoming: string,
  reason: 'addressed' | 'question' | 'disagreement',
): Promise<WrittenText> {
  const stored = await loadBrief(post.postId);
  const brief = stored ?? briefForPost(post);
  const style = styleSheetFor(horse.profile_id);
  const core = await writeGated(
    (variant) => composeReply(brief, style, incoming, reason, variant),
    brief,
    style,
    horse.profile_id,
  );
  return { ...core, brief, style, briefWasStored: Boolean(stored) };
}

/** For logs and for the post_briefs row. */
export { summarise, relevanceOf, areFriends };

/**
 * Persist what the engine understood a post to be about.
 *
 * Fire-and-forget by design: the brief is rebuilt deterministically on every
 * read, so a failed write costs an audit row, never a post. (A table with a
 * reader and no writer is exactly the defect the Phase 1 audit found in
 * pipeline_runs; this is the writer.)
 */
export async function recordBrief(postId: string, brief: PostBrief): Promise<void> {
  try {
    const { error } = await getSupabase().from('post_briefs').upsert(
      {
        post_id: postId,
        kind: brief.kind,
        domain: brief.domain,
        sport: brief.sport ?? null,
        title: brief.title || null,
        source: brief.source ?? null,
        people: brief.people,
        teams: brief.teams,
        concepts: brief.concepts,
        amounts: brief.amounts,
        topic: brief.topic ?? null,
        tone: brief.tone,
        is_question: brief.isQuestion,
        confidence: brief.confidence,
        summary: summarise(brief),
        built_from: [...new Set(brief.builtFrom)],
      },
      { onConflict: 'post_id' },
    );
    if (error) console.warn('[voice] brief write failed:', error.message);
  } catch (e) {
    console.warn('[voice] brief write threw:', e instanceof Error ? e.message : e);
  }
}

/**
 * Record that a reply happened, and the rule that allowed it.
 *
 * An audit row, written after the reply exists: nothing on the publish path
 * reads it. The caps are counted from social_comments itself, over the whole
 * thread (ReplyEngine), because that is what was actually published and this
 * table has no unique key to enforce anything with. `commentId` is the reply
 * just inserted; the six production rows without one (2026-09-05/06) came
 * from code that never passed it (#84, #85; fixed in #108).
 *
 * Returns whether the row was written, so the run can count a failure.
 */
export async function recordThreadTurn(input: {
  postId: string;
  horseId: string;
  commentId?: string | null;
  parentId?: string | null;
  reason: string;
  turnIndex?: number;
}): Promise<boolean> {
  if (!input.commentId) {
    console.warn('[voice] thread state recorded without the reply id; the reply could not be found');
  }
  try {
    const { error } = await getSupabase().from('horse_thread_state').insert({
      post_id: input.postId,
      horse_id: input.horseId,
      comment_id: input.commentId ?? null,
      parent_id: input.parentId ?? null,
      reason: input.reason,
      turn_index: input.turnIndex ?? 1,
    });
    if (error) {
      console.warn('[voice] thread state write failed:', error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[voice] thread state write threw:', e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * Publish each horse's style sheet into content_authors.personality.
 *
 * The sheet is a pure function of the profile id, so the CODE is the source
 * of truth and this is a copy for the admin console: an operator asking "how
 * does this horse write" should get an answer without reading TypeScript.
 *
 * Self-healing and bounded. Every fleet run repairs a slice of horses whose
 * stored style is missing or stale, so a horse created tomorrow converges
 * without anybody remembering to run a backfill - the same pattern
 * fn_socialize_horse uses for identity.
 */
export async function syncStyleSheets(
  fleet: Array<{ profile_id: string; personality?: unknown }>,
  limit = 60,
): Promise<{ checked: number; updated: number }> {
  let updated = 0;
  let checked = 0;
  const supa = getSupabase();

  for (const horse of fleet) {
    if (updated >= limit) break;
    checked++;
    const sheet = styleSheetFor(horse.profile_id);
    const want = styleId(sheet);
    const current = (horse.personality ?? null) as { style?: { style_id?: string } } | null;
    if (current?.style?.style_id === want) continue;

    try {
      const { data: row } = await supa
        .from('content_authors')
        .select('personality')
        .eq('profile_id', horse.profile_id)
        .maybeSingle();
      const existing = ((row?.personality ?? {}) as Record<string, unknown>) || {};
      if ((existing.style as { style_id?: string } | undefined)?.style_id === want) continue;
      const { error } = await supa
        .from('content_authors')
        .update({ personality: { ...existing, style: describeStyle(sheet) } })
        .eq('profile_id', horse.profile_id);
      if (error) {
        console.warn('[voice] style sync failed:', error.message);
        continue;
      }
      updated++;
    } catch (e) {
      console.warn('[voice] style sync threw:', e instanceof Error ? e.message : e);
    }
  }
  return { checked, updated };
}
