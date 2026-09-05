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
import { briefForAsset, briefForPost, summarise, type PostBrief, type BriefSource } from './PostBrief.js';
import { styleSheetFor, styleId, describeStyle, type StyleSheet } from './StyleSheet.js';
import {
  composeCaption,
  composeComment,
  composeReply,
  relevanceOf,
  RELEVANCE_FLOOR,
} from './Composer.js';
import { normalizePhrase, phraseRecentlyUsed } from './ContentLedger.js';
import { areFriends, tagCandidateFor, renderTag, type FriendCandidate } from './FriendGraph.js';
import { fleetHash } from './FleetScheduler.js';
import { getSupabase } from '../supabase.js';

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
}

const MAX_DRAFTS = 6;

/**
 * Draft, check, redraft. Shared by captions and comments so both obey the
 * same two gates.
 */
async function writeGated(
  make: (variant: string) => { text: string; relevance: number; grounding: string[] },
  brief: PostBrief,
  style: StyleSheet,
  horseId: string,
): Promise<Omit<WrittenText, 'brief' | 'style'>> {
  let best: { text: string; relevance: number; grounding: string[] } | null = null;
  let attempts = 0;
  let sawFresh = false;

  for (let i = 0; i < MAX_DRAFTS; i++) {
    attempts = i + 1;
    const draft = make(String(i));
    if (!draft.text) continue;
    if (!best || draft.relevance > best.relevance) best = draft;

    if (draft.relevance < RELEVANCE_FLOOR) continue;
    const norm = normalizePhrase(draft.text);
    if (await phraseRecentlyUsed(norm, horseId)) continue;

    sawFresh = true;
    return {
      text: draft.text,
      relevance: draft.relevance,
      grounding: draft.grounding,
      attempts,
      belowFloor: false,
      stale: false,
    };
  }

  // Nothing cleared both gates. Publish the most relevant draft anyway and
  // say so in the result: a silent horse is the failure Phase 1 was about,
  // and the counters are what tell us the pools need widening.
  const fallback = best ?? { text: '', relevance: 0, grounding: [] };
  return {
    text: fallback.text,
    relevance: fallback.relevance,
    grounding: fallback.grounding,
    attempts,
    belowFloor: fallback.relevance < RELEVANCE_FLOOR,
    stale: !sawFresh,
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

/** A comment on somebody else's post, written after reading it. */
export async function writeComment(
  horse: AuthorHorse,
  post: BriefSource,
): Promise<WrittenText> {
  const brief = briefForPost(post);
  const style = styleSheetFor(horse.profile_id);
  const core = await writeGated(
    (variant) => composeComment(brief, style, variant),
    brief,
    style,
    horse.profile_id,
  );
  return { ...core, brief, style };
}

/** A reply to a specific incoming comment. Short by design. */
export async function writeReply(
  horse: AuthorHorse,
  post: BriefSource,
  incoming: string,
  reason: 'addressed' | 'question' | 'disagreement',
): Promise<WrittenText> {
  const brief = briefForPost(post);
  const style = styleSheetFor(horse.profile_id);
  const core = await writeGated(
    (variant) => composeReply(brief, style, incoming, reason, variant),
    brief,
    style,
    horse.profile_id,
  );
  return { ...core, brief, style };
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
        built_from: brief.builtFrom,
      },
      { onConflict: 'post_id' },
    );
    if (error) console.warn('[voice] brief write failed:', error.message);
  } catch (e) {
    console.warn('[voice] brief write threw:', e instanceof Error ? e.message : e);
  }
}

/** Record that a reply happened, and the rule that allowed it. */
export async function recordThreadTurn(input: {
  postId: string;
  horseId: string;
  commentId?: string | null;
  parentId?: string | null;
  reason: string;
  turnIndex?: number;
}): Promise<void> {
  try {
    const { error } = await getSupabase().from('horse_thread_state').insert({
      post_id: input.postId,
      horse_id: input.horseId,
      comment_id: input.commentId ?? null,
      parent_id: input.parentId ?? null,
      reason: input.reason,
      turn_index: input.turnIndex ?? 1,
    });
    if (error) console.warn('[voice] thread state write failed:', error.message);
  } catch (e) {
    console.warn('[voice] thread state write threw:', e instanceof Error ? e.message : e);
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
