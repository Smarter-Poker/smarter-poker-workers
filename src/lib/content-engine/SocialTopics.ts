/**
 * SocialTopics: what a fleet writer says about the topic of a post it is about
 * to write (Phase 8, design 1.5 to 1.6).
 *
 * social_posts.topic is the single primary domain (poker, sports, slots, other,
 * unknown) and social_posts.topics is [primary, facets...]. The database derives
 * the final pair on every write (fn_social_post_topics behind the trigger
 * trg_social_posts_zz_derive_topics), so a writer that passes nothing is still
 * correct. Writers pass what they know so the row states its intent from the
 * first write and a unit test can pin it. Every kind here is poker: the fleet,
 * Phase 6 and Phase 7 produce poker content only.
 *
 * Facets are lower-case words, never sentences: nothing here reaches a person
 * as text, and nothing here reads who the author is.
 */

export type SocialTopicKind =
  | 'grounded_hand'
  | 'grounded_session'
  | 'news'
  | 'club_data_digest'
  | 'local_event'
  | 'seasonal_local'
  | 'story_poker'
  | 'story_tournament';

export interface SocialTopics {
  /** The primary domain; always equals topics[0]. */
  topic: string;
  /** [primary, facets...], distinct, lower-case, at most 4 elements. */
  topics: string[];
}

const TOPICS_BY_KIND: Readonly<Record<SocialTopicKind, readonly string[]>> = {
  grounded_hand: ['poker', 'hand'],
  grounded_session: ['poker', 'session'],
  news: ['poker', 'news'],
  club_data_digest: ['poker', 'club'],
  local_event: ['poker', 'local'],
  seasonal_local: ['poker', 'local'],
  story_poker: ['poker', 'story'],
  story_tournament: ['poker', 'tournament', 'story'],
};

export const SOCIAL_TOPIC_KINDS = Object.freeze(Object.keys(TOPICS_BY_KIND) as SocialTopicKind[]);

/** The topic and topics a writer of this kind of post passes on its insert. */
export function topicsFor(kind: SocialTopicKind): SocialTopics {
  const topics = [...TOPICS_BY_KIND[kind]];
  return { topic: topics[0]!, topics };
}

/** The story kind for a Phase 7 story draft topic (poker or tournament). */
export function storyTopicKind(draftTopic: 'poker' | 'tournament'): SocialTopicKind {
  return draftTopic === 'tournament' ? 'story_tournament' : 'story_poker';
}
