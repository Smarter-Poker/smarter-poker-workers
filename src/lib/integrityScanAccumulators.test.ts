import { describe, it, expect } from 'vitest';
import { BotTimingAccumulator, ChipDumpAccumulator, timingStats, type TimingHand, type ChipDumpHand } from './integrityScanAccumulators.js';
import { legacyTiming, legacyChipDump, timingDecision, pairDecisions } from '../../scripts/ci/integrity-scan-reference.js';

describe('streamed integrity aggregation equivalence', () => {
  it('matches timing counts, rounded evidence and strict boundaries across pages', () => {
    const hands: TimingHand[] = [];
    for (let i = 0; i < 3600; i++) {
      const actions = [];
      for (const spread of [0, 49, 50, 99, 100, 149, 150, 151, 900]) {
        // Out-of-order actions, aliases and zero delays remain exactly as before.
        const userId = `u${spread}`; const timestamp = 1700000000000 + i * 1000000;
        actions.push({ userId, timestamp: timestamp + 2000 + (i % 2 ? spread : -spread) });
        actions.push({ userId, timestamp }); actions.push({ userId, timestamp });
      }
      actions.push({ id: 'long-idle', ts: 0 }, { id: 'long-idle', ts: 90001 });
      actions.push({ id: 'exact-cap', time: 0 }, { id: 'exact-cap', time: 90000 });
      actions.push({ id: 'invalid', time: NaN });
      hands.push({ actions });
    }
    const expected = legacyTiming(hands); const actual = new BotTimingAccumulator();
    for (const hand of hands) actual.addHand(hand);
    expect([...actual.users.keys()]).toEqual([...expected.keys()]);
    for (const [uid, moments] of actual.users) {
      const stats = timingStats(moments); const ref = expected.get(uid)!;
      expect(moments.count).toBe(ref.count); expect(stats.mean).toBe(ref.mean);
      expect(stats.std).toBeCloseTo(ref.std, 8);
      expect(timingDecision({ count: moments.count, ...stats })).toEqual(timingDecision(ref));
    }
    expect(actual.users.has('long-idle')).toBe(false);
  });

  it('preserves minimum action counts at every severity threshold', () => {
    for (const count of [199, 200, 499, 500, 999, 1000]) {
      for (const spread of [0, 49, 50, 99, 100, 149, 150]) {
        const hands = Array.from({ length: count }, (_, i) => ({ actions: [{ id: 'u', ts: 0 }, { id: 'u', ts: 1000 + (i % 2 ? spread : -spread) }] }));
        const acc = new BotTimingAccumulator(); hands.forEach((h) => acc.addHand(h));
        const m = acc.users.get('u')!;
        expect(timingDecision({ count: m.count, ...timingStats(m) })).toEqual(timingDecision(legacyTiming(hands).get('u')!));
      }
    }
  });

  it('keeps exact integer thresholds stable when observations arrive in shuffled order', () => {
    for (const spread of [50, 100, 150]) {
      const deltas = Array.from({ length: 20000 }, (_, i) => 85000 + (i % 2 ? spread : -spread));
      let seed = 7331;
      for (let i = deltas.length - 1; i > 0; i--) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const j = seed % (i + 1); [deltas[i], deltas[j]] = [deltas[j]!, deltas[i]!];
      }
      const acc = new BotTimingAccumulator();
      deltas.forEach((d) => acc.addHand({ actions: [{ id: 'u', ts: 0 }, { id: 'u', ts: d }] }));
      expect(timingStats(acc.users.get('u')!).std).toBe(spread);
    }
  });

  it('preserves fractional timestamp evidence without integer rounding', () => {
    const hands = Array.from({ length: 2400 }, (_, i) => ({ actions: [
      { id: 'fractional', ts: 0.125 },
      { id: 'fractional', ts: 2000.5 + (i % 9) * 4.125 },
    ] }));
    const acc = new BotTimingAccumulator(); hands.forEach((h) => acc.addHand(h));
    const moments = acc.users.get('fractional')!;
    const ref = legacyTiming(hands).get('fractional')!;
    expect(moments.integerSquares).toBeNull();
    expect(timingStats(moments).std).toBeCloseTo(ref.std, 8);
    expect(timingDecision({ count: moments.count, ...timingStats(moments) })).toEqual(timingDecision(ref));
  });

  it('matches chip-pair evidence for split pots, aliases, duplicate winners and multiple counterparties', () => {
    const hands: ChipDumpHand[] = Array.from({ length: 5000 }, (_, i) => ({
      id: `${i}`, created_at: '2026-09-13T00:00:00Z', pot_size: 500,
      players: [{ user_id: 'giver', chips_invested: 200 }, { userId: `winner${i % 3}`, chips_invested: 200 }, { id: 'free', chips_invested: 0 }],
      winners: i % 7 === 0 ? [{ id: 'giver' }] : i % 11 === 0 ? [{ id: 'giver' }, { id: `winner${i % 3}` }]
        : [{ id: `winner${i % 3}` }, { id: `winner${i % 3}` }],
    }));
    hands.push({ id: 'null', created_at: '', pot_size: null, players: null, winners: null });
    const ref = legacyChipDump(hands); const acc = new ChipDumpAccumulator(); hands.forEach((h) => acc.addHand(h));
    expect(acc.pairs).toEqual(ref.pairs); expect(acc.userTotals).toEqual(ref.userTotals);
    for (const [key, p] of acc.pairs) expect(ref.userVsUserStats.get(key)).toEqual({ hands: p.hands_together, wins: 0 });
    expect(pairDecisions(acc.pairs, acc.userTotals)).toEqual(pairDecisions(ref.pairs, ref.userTotals));
  });
});
