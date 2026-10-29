// Independent snapshot of the pre-correction timing calculation.
import type { TimingCorrelationAccumulator } from '../../src/routes/collusion-scan.js';
type ActionRow = Parameters<TimingCorrelationAccumulator['addHand']>[0][number];
type Finding = ReturnType<TimingCorrelationAccumulator['findings']>[number];
const MIN_HANDS_FOR_SIGNAL = 15;
const TIMING_MIN_Z = 4;
const pairKey = (a: string, b: string) => a < b ? `${a}|${b}` : `${b}|${a}`;
export function legacyCollusionTiming(actions: ActionRow[]): Finding[] {
  const byHand = new Map<string, ActionRow[]>();
  for (const a of actions) {
    if (!a.hand_id) continue;
    const arr = byHand.get(a.hand_id) ?? [];
    arr.push(a);
    byHand.set(a.hand_id, arr);
  }

  interface TStat {
    a: string;
    b: string;
    closeEvents: number;
    totalEvents: number;
  }
  const pairStats = new Map<string, TStat>();

  for (const handActions of byHand.values()) {
    handActions.sort(
      (x, y) => new Date(x.created_at).getTime() - new Date(y.created_at).getTime(),
    );
    for (let i = 0; i < handActions.length - 1; i++) {
      const cur = handActions[i]!;
      const next = handActions[i + 1]!;
      if (!cur.user_id || !next.user_id || cur.user_id === next.user_id) continue;
      const dt = Math.abs(
        new Date(next.created_at).getTime() - new Date(cur.created_at).getTime(),
      );
      const key = pairKey(cur.user_id, next.user_id);
      const existing = pairStats.get(key);
      const stat: TStat = existing ?? {
        a: cur.user_id < next.user_id ? cur.user_id : next.user_id,
        b: cur.user_id < next.user_id ? next.user_id : cur.user_id,
        closeEvents: 0,
        totalEvents: 0,
      };
      stat.totalEvents += 1;
      if (dt < 500) stat.closeEvents += 1;
      pairStats.set(key, stat);
    }
  }

  /**
   * THE BASELINE IS MEASURED, NOT ASSUMED (fixed 2026-09-05). The old test was
   * `zish = (ratio - 0.15) / 0.08` - a hardcoded population rate and a
   * hardcoded standard deviation, neither scaling with sample size, so it was
   * not a z-score at all. With the ratio gate at 0.35 it evaluated to exactly
   * 2.5 against a 2.5 threshold, meaning the significance test was a no-op and
   * the whole rule was "35% of adjacent actions inside 500ms over 15 events".
   *
   * On this platform that is close to a description of the fleet: horses act
   * on a timer, so two horses in sequence are fast by construction. It wrote
   * 910 rows since 2026-08-28 and NOT ONE has ever been reviewed.
   *
   * The fix is not to exclude horses - CLAUDE.md 10.5 - it is to compare each
   * pair against the rate this population actually produces, with a binomial
   * standard error that shrinks as the pair plays more. A fast pool raises the
   * baseline for everybody, and standing out means standing out from the room.
   */
  let totalClose = 0;
  let totalEvents = 0;
  for (const stat of pairStats.values()) {
    totalClose += stat.closeEvents;
    totalEvents += stat.totalEvents;
  }
  const baseRate = totalEvents > 0 ? totalClose / totalEvents : 0;

  const findings: Finding[] = [];
  if (!(baseRate > 0) || baseRate >= 1) return findings;

  for (const stat of pairStats.values()) {
    if (stat.totalEvents < MIN_HANDS_FOR_SIGNAL) continue;
    const ratio = stat.closeEvents / stat.totalEvents;
    if (ratio <= baseRate) continue;
    const se = Math.sqrt((baseRate * (1 - baseRate)) / stat.totalEvents);
    if (!(se > 0)) continue;
    const z = (ratio - baseRate) / se;
    if (z < TIMING_MIN_Z) continue;

    findings.push({
      player_a: stat.a,
      player_b: stat.b,
      pattern_type: 'TIMING_CORRELATION',
      suspicion_score: Math.min(100, Math.round(50 + (z - TIMING_MIN_Z) * 10)),
      evidence: {
        close_action_pairs: stat.closeEvents,
        total_adjacent_actions: stat.totalEvents,
        close_ratio: Number(ratio.toFixed(3)),
        population_rate: Number(baseRate.toFixed(3)),
        z_score: Number(z.toFixed(2)),
        threshold_z: TIMING_MIN_Z,
        threshold_ms: 500,
        method: 'share of adjacent actions inside 500ms, against the population rate for this window',
      },
    });
  }
  return findings;
}
