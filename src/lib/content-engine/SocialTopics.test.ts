import { describe, expect, it } from 'vitest';
import { SOCIAL_TOPIC_KINDS, storyTopicKind, topicsFor, type SocialTopicKind } from './SocialTopics.js';

const FACETS = new Set(['cash', 'tournament', 'hand', 'session', 'puzzle', 'story', 'news', 'club', 'local', 'strategy']);
const PRIMARIES = new Set(['unknown', 'poker', 'slots', 'sports', 'other']);

describe('topicsFor: what a fleet writer says about a post before the database derives the rest', () => {
  it.each([
    ['grounded_hand', ['poker', 'hand']],
    ['grounded_session', ['poker', 'session']],
    ['news', ['poker', 'news']],
    ['club_data_digest', ['poker', 'club']],
    ['local_event', ['poker', 'local']],
    ['seasonal_local', ['poker', 'local']],
    ['story_poker', ['poker', 'story']],
    ['story_tournament', ['poker', 'tournament', 'story']],
  ] as const)('%s -> %j', (kind, expected) => {
    expect(topicsFor(kind)).toEqual({ topic: 'poker', topics: [...expected] });
  });

  it('every kind yields a legal primary first, distinct lower-case facets after it, at most 4 elements', () => {
    expect(SOCIAL_TOPIC_KINDS).toHaveLength(8);
    for (const kind of SOCIAL_TOPIC_KINDS) {
      const { topic, topics } = topicsFor(kind);
      expect(topics[0]).toBe(topic);
      expect(PRIMARIES.has(topic)).toBe(true);
      expect(topics.length).toBeGreaterThanOrEqual(1);
      expect(topics.length).toBeLessThanOrEqual(4);
      expect(new Set(topics).size).toBe(topics.length);
      for (const facet of topics.slice(1)) {
        expect(FACETS.has(facet)).toBe(true);
        expect(facet).toBe(facet.toLowerCase());
      }
    }
  });

  it('tournament is a facet under poker, never the primary a Phase 8 writer sends', () => {
    for (const kind of SOCIAL_TOPIC_KINDS) expect(topicsFor(kind).topic).not.toBe('tournament');
    expect(topicsFor('story_tournament').topics).toContain('tournament');
  });

  it('returns a fresh array each call so a caller cannot mutate the table', () => {
    const first = topicsFor('news');
    first.topics.push('mutated');
    expect(topicsFor('news').topics).toEqual(['poker', 'news']);
  });

  it('maps a Phase 7 story draft topic to its story kind', () => {
    expect(storyTopicKind('poker')).toBe<SocialTopicKind>('story_poker');
    expect(storyTopicKind('tournament')).toBe<SocialTopicKind>('story_tournament');
  });
});
