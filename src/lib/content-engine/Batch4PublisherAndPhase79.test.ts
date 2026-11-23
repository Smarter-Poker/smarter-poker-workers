import { describe, expect, it } from 'vitest';
import { isCaptionableSharedVideoClip } from './HorsePublisher.js';
import { selectFairHorsePostQueue } from '../../routes/horse-posts.js';
import { pokerVideoContextFact, pokerVideoQuestionFact } from './VideoContextFact.js';
import { strategyTopicFact } from './StrategyTopicFact.js';
import { briefForAsset } from './PostBrief.js';
import { composePuzzle } from './PuzzleComposer.js';

describe('Batch 4: publisher supply, fair rotation, and Phase 7/9 hardening', () => {
  it('rejects all_in_context clips in shared video preflight so they never burn caption attempts', () => {
    expect(isCaptionableSharedVideoClip({
      title: 'Navigating A Chaos 5-Way All-In',
      source: 'Hustler Casino Live',
    }, 'poker')).toBe(false);

    expect(isCaptionableSharedVideoClip({
      title: 'Triton Poker Jeju 2026 Event #5 Final Table',
      source: 'Triton Poker',
    }, 'poker')).toBe(true);
  });

  it('recognizes Triton Poker and TCH Live final-table streams in pokerVideoContextFact', () => {
    const triton = pokerVideoContextFact(
      'Triton Poker Jeju 2026 Event #5 Final Table',
      'Triton Poker',
    );
    expect(triton).not.toBeNull();
    expect(triton?.identity).toContain('triton');

    const tch = pokerVideoContextFact(
      'PokerAtlas Tour NLH Final Table Live Stream',
      'TCH Live',
    );
    expect(tch).not.toBeNull();
    expect(tch?.identity).toContain('pokeratlas');
  });

  it('recognizes verified coaching decision questions and November strategy lessons', () => {
    const q1 = pokerVideoQuestionFact('Small Bet or Large Bet?', 'GTO Wizard');
    expect(q1).not.toBeNull();
    expect(q1?.action).toBe('poker_question_context');

    const q2 = pokerVideoQuestionFact('Would You Raise This Flop?', 'Jonathan Little');
    expect(q2).not.toBeNull();
    expect(q2?.identity).toContain('raise');

    const q3 = pokerVideoQuestionFact('Should You Call This River Bet?', 'Phil Galfond');
    expect(q3).not.toBeNull();
    expect(q3?.identity).toContain('call');

    const gtoLesson = strategyTopicFact(briefForAsset({
      kind: 'video',
      domainHint: 'poker',
      title: 'Why You Need to Understand GTO to Play Poker',
      source: 'Phil Galfond',
    }));
    expect(gtoLesson?.identity).toBe('poker_strategy:understanding_gto');

    const winRateLesson = strategyTopicFact(briefForAsset({
      kind: 'video',
      domainHint: 'poker',
      title: 'Poker Players: Why a Higher Win Rate Can Be Better Than Higher Stakes',
      source: 'Phil Galfond',
    }));
    expect(winRateLesson?.identity).toBe('poker_strategy:winrate_vs_stakes');

    const mttLesson = strategyTopicFact(briefForAsset({
      kind: 'video',
      domainHint: 'poker',
      title: 'THE TOURNAMENT MASTERCLASS [Run Deep in MTTs]',
      source: 'PokerCoaching',
    }));
    expect(mttLesson?.identity).toBe('poker_strategy:mtt_deep_runs');
  });

  it('rotates over-cap equal-age cohorts across UTC hours while still prioritizing older slots', () => {
    const horses = Array.from({ length: 60 }, (_, i) => ({
      horse: { profile_id: `horse-${String(i).padStart(3, '0')}` },
      due: { age: i < 5 ? 2 : 0 },
    }));

    const h1 = selectFairHorsePostQueue(horses, new Date('2026-11-23T14:00:00Z'), 20);
    const h2 = selectFairHorsePostQueue(horses, new Date('2026-11-23T15:00:00Z'), 20);

    expect(h1).toHaveLength(20);
    expect(h2).toHaveLength(20);
    // The 5 older-slot horses (age 2) always come first in both hours.
    expect(h1.slice(0, 5).map((x) => x.horse.profile_id).sort()).toEqual([
      'horse-000', 'horse-001', 'horse-002', 'horse-003', 'horse-004',
    ]);
    expect(h2.slice(0, 5).map((x) => x.horse.profile_id).sort()).toEqual([
      'horse-000', 'horse-001', 'horse-002', 'horse-003', 'horse-004',
    ]);
    // The remaining 15 slots from the age-0 cohort rotate cleanly between hours.
    const rest1 = h1.slice(5).map((x) => x.horse.profile_id);
    const rest2 = h2.slice(5).map((x) => x.horse.profile_id);
    expect(rest1).not.toEqual(rest2);
  });

  it('keeps puzzle reveal comment length within the 500-char social_comments limit', () => {
    const out = composePuzzle('nuts', {
      id: 829413,
      hand_id: 'bbbbbbbb-0000-4000-8000-000000000001',
      horse_user_id: 'aaaaaaaa-0000-4000-8000-00000000h0r5',
      game_variant: 'nlh',
      format: 'cash',
      big_blind: 5,
      played_at: '2026-09-29T20:00:00Z',
      net_bb: 58.6,
      is_win: true,
      pot_size: 201,
      seat: 5,
      hole_cards: [{ rank: 'T', suit: 'hearts' }, { rank: 'J', suit: 'clubs' }],
      board: [
        { rank: '2', suit: 'clubs' },
        { rank: '7', suit: 'clubs' },
        { rank: 'A', suit: 'clubs' },
        { rank: 'Q', suit: 'clubs' },
        { rank: '2', suit: 'diamonds' },
      ],
      actions: [],
    }, {
      salt: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
      now: new Date('2026-09-30T01:00:00Z'),
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      const correctOption = out.puzzle.options.find((o) => o.key === out.puzzle.correct_option)!;
      expect(out.puzzle.explanation.length + correctOption.label.length + 32).toBeLessThanOrEqual(500);
    }
  });
});
