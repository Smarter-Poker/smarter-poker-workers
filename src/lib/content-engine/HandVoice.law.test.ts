/**
 * Laws for the proposed grounded-hand voice.
 *
 * These tests do not approve the voice. They enforce the factual and writing
 * boundaries around the samples that a person still has to approve.
 */
import { describe, expect, it } from 'vitest';
import type { HandFacts, HandCategory } from './HandStory.js';
import {
  lineFor,
  sayBoard,
  sayHolding,
  sayMoney,
  spokenLineMatches,
} from './HandVoice.js';

function facts(
  category: HandCategory,
  overrides: Partial<HandFacts> = {},
): HandFacts {
  return {
    handId: 'hand-1',
    playedAt: '2026-09-06T12:00:00Z',
    variant: 'nlh',
    format: 'cash',
    bigBlind: 2,
    hole: [
      { rank: 'A', suit: 'spades' },
      { rank: 'A', suit: 'hearts' },
    ],
    board: [
      { rank: 'K', suit: 'clubs' },
      { rank: '9', suit: 'clubs' },
      { rank: '6', suit: 'diamonds' },
      { rank: '4', suit: 'hearts' },
      { rank: '2', suit: 'spades' },
    ],
    netBb: category === 'big_win' || category === 'river_aggression' ? 140 : -140,
    potBb: 220,
    isWin: category === 'big_win' || category === 'river_aggression',
    leaks: [],
    category,
    holeNotation: 'AA',
    boardNotation: 'Kc 9c 6d 4h 2s',
    street: 'river',
    ...overrides,
  };
}

function rendered(f: HandFacts): Array<{ text: string; key: string }> {
  const lines = new Map<string, { text: string; key: string }>();
  for (let i = 0; i < 500; i += 1) {
    const line = lineFor(f, `seed-${i}`);
    if (line) lines.set(line.key, line);
  }
  return [...lines.values()];
}

describe('a hand is spoken, not printed', () => {
  it('names common holdings naturally and does not recite Omaha cards', () => {
    expect(sayHolding('AA', 'nlh')).toBe('pocket aces');
    expect(sayHolding('aks', 'nlh')).toBe('ace-king suited');
    expect(sayHolding('72o', 'nlh')).toBe('seven-deuce offsuit');
    expect(sayHolding('AsKhQdJc', 'plo4')).toBeNull();
  });

  it('describes board texture without exposing the board', () => {
    expect(sayBoard(facts('grind'))).toBe('a connected board');
    expect(sayBoard(facts('grind', {
      board: [
        { rank: 'K', suit: 'clubs' },
        { rank: '9', suit: 'clubs' },
        { rank: '6', suit: 'clubs' },
        { rank: '4', suit: 'hearts' },
        { rank: '2', suit: 'spades' },
      ],
    }))).toBe('a three-flush board');
  });

  it('uses grammatical scale phrases instead of database units', () => {
    expect(sayMoney(facts('big_win', { netBb: 240, isWin: true }))).toBe('a monster pot');
    expect(sayMoney(facts('bad_beat', { netBb: -240, isWin: false }))).toBe('a brutal pot');
    expect(sayMoney(facts('bad_beat', { netBb: -120, isWin: false }))).toBe('a stack-sized pot');
  });
});

describe('every proposed sentence keeps the same laws', () => {
  const cases: HandFacts[] = [
    facts('big_win'),
    facts('bad_beat'),
    facts('cooler'),
    facts('river_aggression'),
    facts('big_fold'),
    facts('stackoff', { isWin: true, netBb: 120 }),
    facts('stackoff', { isWin: false, netBb: -120 }),
    facts('grind', { isWin: true, netBb: 12 }),
    facts('grind', { isWin: false, netBb: -12 }),
  ];

  it('renders broad, category-specific variety', () => {
    for (const f of cases) {
      expect(rendered(f).length, f.category).toBeGreaterThanOrEqual(8);
    }
  });

  it('never leaks notation, units, placeholders, broken articles, or em dashes', () => {
    for (const f of cases) {
      for (const line of rendered(f)) {
        expect(spokenLineMatches(line.text, f), line.text).toBe(true);
        expect(line.text).not.toMatch(/\b(?:a a|a an|the a)\b/i);
        expect(line.text).not.toMatch(/[{}]/);
        expect(line.text).not.toContain('—');
        expect(line.text[0]).toMatch(/[A-Z0-9]/);
        expect(line.text).not.toMatch(/[.!?]\s+[a-z]/);
      }
    }
  });

  it('does not claim a river, win, or loss the row does not support', () => {
    const flopLoss = facts('bad_beat', {
      board: [
        { rank: 'K', suit: 'clubs' },
        { rank: '9', suit: 'clubs' },
        { rank: '6', suit: 'diamonds' },
      ],
      boardNotation: 'Kc 9c 6d',
      street: 'flop',
    });
    for (const line of rendered(flopLoss)) {
      expect(line.text).not.toMatch(/\briver\b/i);
      expect(line.text).not.toMatch(/\bwon\b|\bcollected\b/i);
    }
    expect(lineFor(facts('river_aggression', { street: 'flop' }), 'seed')).toBeNull();
  });

  it('returns silence after the category frame pool is exhausted', () => {
    const f = facts('big_win');
    const used = new Set<string>();
    while (true) {
      const line = lineFor(f, 'fixed-seed', used);
      if (!line) break;
      expect(used.has(line.key)).toBe(false);
      used.add(line.key);
    }
    expect(used.size).toBeGreaterThanOrEqual(8);
    expect(lineFor(f, 'another-seed', used)).toBeNull();
  });

  it('rejects unsafe text even if a future template introduces it', () => {
    const f = facts('grind', { isWin: false, netBb: -20, street: 'flop' });
    expect(spokenLineMatches('Lost 184bb with AsKs.', f)).toBe(false);
    expect(spokenLineMatches('The river was rough.', f)).toBe(false);
    expect(spokenLineMatches('Won a small pot.', f)).toBe(false);
    expect(spokenLineMatches('A normal poker sentence.', f)).toBe(true);
  });
});
