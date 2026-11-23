import { describe, expect, it } from 'vitest';
import { briefForAsset, briefForPost } from './PostBrief.js';
import { composeComment, composeStory, RELEVANCE_FLOOR, relevanceOf } from './Composer.js';
import { styleSheetFor } from './StyleSheet.js';

const style = styleSheetFor('00000000-0000-4000-8000-000000000042');

describe('composeStory and comment concept coverage', () => {
  it('composes grounded styled text stories for poker topic seeds and refuses non-text briefs', () => {
    const seeds = [
      'Just watched the sickest cooler on stream.',
      'Solver vs exploitative, the debate never ends.',
      'Hot take: 3bet sizing in live poker is way too small.',
      'Bankroll management is the most underrated skill in poker.',
      'The river is always the cruelest street.',
      'Variance is real and nobody is immune.',
    ];
    for (const seed of seeds) {
      const brief = briefForAsset({ kind: 'text', title: seed, source: null, domainHint: 'poker' });
      const out = composeStory(brief, style, '0');
      expect(out.text.length, seed).toBeGreaterThan(10);
      expect(out.relevance, seed).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
      expect(out.semanticKey).toBeTruthy();
    }

    const videoBrief = briefForAsset({ kind: 'video', title: 'Phil Ivey fires a river bluff', source: 'PokerGO', domainHint: 'poker' });
    expect(composeStory(videoBrief, style, '0').text).toBe('');
  });

  it('produces relevant comments for previously uncovered poker concepts and hyphenated forms', () => {
    const titles = [
      'Big turn card changes everything in $5/$10 cash',
      'Four-bet pot with suited connectors in position',
      'Flopping a set on a flush draw board',
      'Moving up in stakes for the $100K guarantee top prize',
    ];
    for (const title of titles) {
      const brief = briefForPost({
        postId: `p:${title}`,
        contentType: 'text',
        content: title,
        metadata: { domain: 'poker' },
      });
      const out = composeComment(brief, style, '0');
      expect(out.text.length, title).toBeGreaterThan(8);
      expect(out.relevance, title).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
    }

    const gtoBrief = briefForAsset({ kind: 'text', title: 'GTO baseline', source: null, domainHint: 'poker' });
    expect(relevanceOf('Solvers are a map, not the territory', gtoBrief)).toBeGreaterThanOrEqual(RELEVANCE_FLOOR);
  });
});
