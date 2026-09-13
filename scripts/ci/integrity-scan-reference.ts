/** Frozen pre-streaming aggregation from workers 73e2793. Test oracle only.
 * Deliberately retains arrays and uses the original two-pass population
 * standard deviation so the new sufficient statistics are tested independently. */
import type { TimingHand, ChipDumpHand, ScanPlayer, ChipDumpPair } from '../../src/lib/integrityScanAccumulators.js';
const uidOf = (p: ScanPlayer | null | undefined) => p?.user_id ?? p?.userId ?? p?.id ?? null;

export function legacyTiming(hands: TimingHand[]) {
  const deltasByUser = new Map<string, number[]>();
  for (const hand of hands) {
    const perHand = new Map<string, number[]>();
    for (const a of hand.actions ?? []) {
      if (!a) continue;
      const uid = uidOf(a);
      const ts = a.timestamp ?? a.ts ?? a.time;
      if (!uid || typeof ts !== 'number') continue;
      const values = perHand.get(uid) ?? []; values.push(ts); perHand.set(uid, values);
    }
    for (const [uid, values] of perHand) {
      if (values.length < 2) continue;
      values.sort((a, b) => a - b);
      const deltas: number[] = [];
      for (let i = 1; i < values.length; i++) {
        const d = values[i]! - values[i - 1]!;
        if (d > 0 && d <= 90_000) deltas.push(d);
      }
      if (!deltas.length) continue;
      const existing = deltasByUser.get(uid) ?? []; existing.push(...deltas); deltasByUser.set(uid, existing);
    }
  }
  return new Map([...deltasByUser].map(([uid, deltas]) => {
    const mean = deltas.reduce((s, d) => s + d, 0) / deltas.length;
    const variance = deltas.reduce((s, d) => s + (d - mean) * (d - mean), 0) / deltas.length;
    return [uid, { count: deltas.length, mean, std: Math.sqrt(variance) }];
  }));
}

export function legacyChipDump(hands: ChipDumpHand[]) {
  const pairs = new Map<string, ChipDumpPair>();
  const userTotals = new Map<string, { hands: number; wins: number }>();
  const userVsUserStats = new Map<string, { hands: number; wins: number }>();
  for (const hand of hands) {
    const players = hand.players ?? [];
    const winnerIds = new Set((hand.winners ?? []).map(uidOf).filter(Boolean) as string[]);
    for (const p of players) {
      const uid = uidOf(p); if (!uid) continue;
      const t = userTotals.get(uid) ?? { hands: 0, wins: 0 };
      t.hands += 1; if (winnerIds.has(uid)) t.wins += 1; userTotals.set(uid, t);
    }
    if (winnerIds.size !== 1) continue;
    const winnerId = Array.from(winnerIds)[0]!;
    for (const p of players) {
      const giverId = uidOf(p); if (!giverId || giverId === winnerId) continue;
      const invested = Number(p.chips_invested ?? 0) || 0; if (invested <= 0) continue;
      const key = `${giverId}|${winnerId}`;
      const acc = pairs.get(key) ?? { giver: giverId, receiver: winnerId, hands_together: 0, giver_losses_to_receiver: 0, net_transfer: 0 };
      acc.hands_together++; acc.giver_losses_to_receiver++; acc.net_transfer += invested; pairs.set(key, acc);
      const vs = userVsUserStats.get(key) ?? { hands: 0, wins: 0 }; vs.hands++; userVsUserStats.set(key, vs);
    }
  }
  return { pairs, userTotals, userVsUserStats };
}

export const timingDecision = (s: { count: number; mean: number; std: number }) => ({
  count: s.count, mean: Math.round(s.mean), std: Math.round(s.std),
  severity: s.std < 50 && s.count >= 1000 ? 'critical' : s.std < 100 && s.count >= 500 ? 'high'
    : s.std < 150 && s.count >= 200 ? 'medium' : null,
});

export function pairDecisions(pairs: Map<string, ChipDumpPair>, users: Map<string, { hands: number; wins: number }>) {
  return [...pairs].filter(([, a]) => a.hands_together >= 30 && a.giver_losses_to_receiver / a.hands_together >= .8 && a.net_transfer >= 5000)
    .map(([key, a]) => {
      const totals = users.get(a.giver);
      const rest = (totals?.hands ?? 0) - a.hands_together;
      const ratio = rest > 0 ? (totals?.wins ?? 0) / rest : 0;
      return { key, ...a, outsideWinRate: Number(ratio.toFixed(3)), severity: ratio >= .5 ? 'critical' : 'high' };
    });
}
