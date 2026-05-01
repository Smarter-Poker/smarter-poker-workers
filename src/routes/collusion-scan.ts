/**
 * GET/POST /cron/collusion-scan
 *
 * Ported from pages/api/cron/collusion-scan.js (410 lines).
 *
 * Nightly 03:30 UTC: scan last 24h of hand_history + action_log for
 * suspicious player-pair patterns. Writes findings to collusion_tracking
 * with status='open' for human review.
 *
 * Patterns:
 *   CHIP_DUMP          — pair where one consistently ships pots to the other
 *                        (≥80% loss ratio over ≥15 hands)
 *   SOFT_PLAY          — mutual checkdowns post-flop without raises
 *                        (≥15 checkdown hands)
 *   TIMING_CORRELATION — adjacent-action timing on same hand <500ms in
 *                        ≥35% of cases AND z-score ≥ 2.5 vs 15% baseline
 *   WIN_RATE_ANOMALY   — pair bb/100 magnitude ≥80 over ≥30 hands together
 *
 * (CONCURRENT_IP from the original spec is documented but not implemented
 * in the JS source — preserved verbatim, no port needed.)
 *
 * Idempotence: insert-only into collusion_tracking. Same window + same
 * data produces the same findings, so re-runs may double-insert. Source
 * comment claims dedupe via upsert on tuple — actual JS uses .insert()
 * straight. Ported at parity (still .insert()).
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const WINDOW_HOURS = 24;
const MIN_HANDS_FOR_SIGNAL = 15;
const CHIP_DUMP_LOSS_RATIO = 0.8;
const TIMING_Z_SCORE = 2.5;

interface PlayerSeat {
  user_id?: string;
  userId?: string;
  id?: string;
}

interface HandAction {
  street?: string;
  action?: string;
}

interface HandRow {
  id: string;
  table_id: string | null;
  hand_number: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  players: PlayerSeat[] | null;
  winners: PlayerSeat[] | null;
  actions: HandAction[] | null;
  pot_size: number | string | null;
  big_blind: number | string | null;
  small_blind: number | string | null;
}

interface ActionRow {
  id: string;
  table_id: string | null;
  hand_id: string | null;
  user_id: string | null;
  created_at: string;
  street: string | null;
  action: string | null;
}

interface Finding {
  player_a: string;
  player_b: string;
  pattern_type: 'CHIP_DUMP' | 'SOFT_PLAY' | 'TIMING_CORRELATION' | 'WIN_RATE_ANOMALY';
  suspicion_score: number;
  evidence: Record<string, unknown>;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function extractPlayerIds(handRow: HandRow): string[] {
  if (!handRow.players) return [];
  if (!Array.isArray(handRow.players)) return [];
  return handRow.players
    .map((p) => p?.user_id ?? p?.userId ?? p?.id)
    .filter((id): id is string => !!id);
}

function scanChipDump(hands: HandRow[]): Finding[] {
  interface CDStat {
    a: string;
    b: string;
    aLoses: number;
    bLoses: number;
    total: number;
    potSum: number;
  }
  const pairStats = new Map<string, CDStat>();
  for (const h of hands) {
    const players = extractPlayerIds(h);
    if (players.length < 2) continue;

    const winners = Array.isArray(h.winners) ? h.winners : [];
    const winnerIds = winners
      .map((w) => w?.user_id ?? w?.userId ?? w?.id)
      .filter((id): id is string => !!id);
    if (winnerIds.length !== 1) continue;
    const winner = winnerIds[0]!;

    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i]!;
        const b = players[j]!;
        const key = pairKey(a, b);
        const existing = pairStats.get(key);
        const stat: CDStat = existing ?? {
          a: a < b ? a : b,
          b: a < b ? b : a,
          aLoses: 0,
          bLoses: 0,
          total: 0,
          potSum: 0,
        };
        stat.total += 1;
        stat.potSum += Number(h.pot_size ?? 0);
        if (winner === stat.a) stat.bLoses += 1;
        else if (winner === stat.b) stat.aLoses += 1;
        pairStats.set(key, stat);
      }
    }
  }

  const findings: Finding[] = [];
  for (const stat of pairStats.values()) {
    if (stat.total < MIN_HANDS_FOR_SIGNAL) continue;
    const losesA = stat.aLoses / stat.total;
    const losesB = stat.bLoses / stat.total;
    if (losesA >= CHIP_DUMP_LOSS_RATIO || losesB >= CHIP_DUMP_LOSS_RATIO) {
      const dominantLoser = losesA >= losesB ? stat.a : stat.b;
      const dominantWinner = losesA >= losesB ? stat.b : stat.a;
      const ratio = Math.max(losesA, losesB);
      const score = Math.min(100, Math.round(ratio * 100 + (stat.total >= 40 ? 10 : 0)));
      findings.push({
        player_a: dominantLoser,
        player_b: dominantWinner,
        pattern_type: 'CHIP_DUMP',
        suspicion_score: score,
        evidence: {
          hands: stat.total,
          loser_loss_ratio: Number(ratio.toFixed(3)),
          pot_volume: Number(stat.potSum.toFixed(2)),
        },
      });
    }
  }
  return findings;
}

function scanSoftPlay(hands: HandRow[]): Finding[] {
  interface SPStat {
    a: string;
    b: string;
    checkdowns: number;
    total: number;
  }
  const pairStats = new Map<string, SPStat>();
  for (const h of hands) {
    const players = extractPlayerIds(h);
    if (players.length < 2) continue;
    const actions = Array.isArray(h.actions) ? h.actions : [];
    const postflopActions = actions.filter(
      (a) => a && ['flop', 'turn', 'river'].includes(a.street ?? ''),
    );
    if (postflopActions.length === 0) continue;
    const raises = postflopActions.filter(
      (a) => a.action === 'bet' || a.action === 'raise' || a.action === 'all-in',
    ).length;
    const checks = postflopActions.filter((a) => a.action === 'check').length;
    if (!(checks >= 3 && raises === 0)) continue;

    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i]!;
        const b = players[j]!;
        const key = pairKey(a, b);
        const existing = pairStats.get(key);
        const stat: SPStat = existing ?? {
          a: a < b ? a : b,
          b: a < b ? b : a,
          checkdowns: 0,
          total: 0,
        };
        stat.total += 1;
        stat.checkdowns += 1;
        pairStats.set(key, stat);
      }
    }
  }

  const findings: Finding[] = [];
  for (const stat of pairStats.values()) {
    if (stat.checkdowns < MIN_HANDS_FOR_SIGNAL) continue;
    const score = Math.min(100, 40 + Math.min(60, stat.checkdowns * 2));
    findings.push({
      player_a: stat.a,
      player_b: stat.b,
      pattern_type: 'SOFT_PLAY',
      suspicion_score: score,
      evidence: {
        mutual_checkdowns: stat.checkdowns,
        threshold: MIN_HANDS_FOR_SIGNAL,
      },
    });
  }
  return findings;
}

function scanTimingCorrelation(actions: ActionRow[]): Finding[] {
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

  const findings: Finding[] = [];
  for (const stat of pairStats.values()) {
    if (stat.totalEvents < MIN_HANDS_FOR_SIGNAL) continue;
    const ratio = stat.closeEvents / stat.totalEvents;
    if (ratio < 0.35) continue;
    const zish = (ratio - 0.15) / 0.08;
    if (zish < TIMING_Z_SCORE) continue;
    const score = Math.min(100, Math.round(40 + ratio * 60));
    findings.push({
      player_a: stat.a,
      player_b: stat.b,
      pattern_type: 'TIMING_CORRELATION',
      suspicion_score: score,
      evidence: {
        close_action_pairs: stat.closeEvents,
        total_adjacent_actions: stat.totalEvents,
        close_ratio: Number(ratio.toFixed(3)),
        threshold_ms: 500,
      },
    });
  }
  return findings;
}

function scanWinRateAnomaly(hands: HandRow[]): Finding[] {
  interface WStat {
    a: string;
    b: string;
    handsTogether: number;
    aWins: number;
    bWins: number;
    bbFlowAtoB: number;
  }
  const pairStats = new Map<string, WStat>();

  for (const h of hands) {
    const bb = Number(h.big_blind ?? 0) || 1;
    const pot = Number(h.pot_size ?? 0);
    const winners = Array.isArray(h.winners) ? h.winners : [];
    const winnerIds = winners
      .map((w) => w?.user_id ?? w?.userId ?? w?.id)
      .filter((id): id is string => !!id);
    if (winnerIds.length !== 1) continue;
    const winner = winnerIds[0]!;
    const players = extractPlayerIds(h);
    if (players.length < 2) continue;

    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i]!;
        const b = players[j]!;
        const key = pairKey(a, b);
        const existing = pairStats.get(key);
        const stat: WStat = existing ?? {
          a: a < b ? a : b,
          b: a < b ? b : a,
          handsTogether: 0,
          aWins: 0,
          bWins: 0,
          bbFlowAtoB: 0,
        };
        stat.handsTogether += 1;
        const bbDelta = pot / bb;
        if (winner === stat.a) {
          stat.aWins += 1;
          stat.bbFlowAtoB -= bbDelta;
        } else if (winner === stat.b) {
          stat.bWins += 1;
          stat.bbFlowAtoB += bbDelta;
        }
        pairStats.set(key, stat);
      }
    }
  }

  const findings: Finding[] = [];
  for (const stat of pairStats.values()) {
    if (stat.handsTogether < 30) continue;
    const bb100 = (stat.bbFlowAtoB / stat.handsTogether) * 100;
    if (Math.abs(bb100) < 80) continue;
    const winner = bb100 > 0 ? stat.b : stat.a;
    const loser = bb100 > 0 ? stat.a : stat.b;
    const score = Math.min(100, 50 + Math.min(50, Math.round(Math.abs(bb100) / 4)));
    findings.push({
      player_a: loser,
      player_b: winner,
      pattern_type: 'WIN_RATE_ANOMALY',
      suspicion_score: score,
      evidence: {
        hands_together: stat.handsTogether,
        bb_per_100: Number(bb100.toFixed(1)),
        direction: 'loser_to_winner',
      },
    });
  }
  return findings;
}

export async function collusionScan(c: Context) {
  const supabase = getSupabase();
  const scanStart = Date.now();
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - WINDOW_HOURS * 3600 * 1000);

  try {
    const { data: handsData, error: handErr } = await supabase
      .from('hand_history')
      .select(
        'id, table_id, hand_number, started_at, ended_at, created_at, players, winners, actions, pot_size, big_blind, small_blind',
      )
      .gte('created_at', windowStart.toISOString())
      .lt('created_at', windowEnd.toISOString())
      .limit(50000);

    if (handErr) {
      console.warn('[collusion-scan] hand_history read error:', handErr.message);
      return c.json({ error: handErr.message }, 500);
    }

    const handsRows = (handsData ?? []) as HandRow[];

    // Round 67 fix: action_log was always empty in production (legacy table
    // — no code ever wrote there). The TIMING_CORRELATION pattern silently
    // starved on every scan. Now we synthesize per-action rows from
    // hand_history.actions[] JSONB which IS populated by every hand.
    const actionRows: ActionRow[] = [];
    for (const h of handsRows) {
      const arr = Array.isArray(h.actions) ? h.actions : [];
      for (const a of arr as Array<Record<string, unknown>>) {
        const uid = (a.userId ?? a.user_id ?? a.id) as string | undefined;
        const tsRaw = (a.timestamp ?? a.ts ?? a.time) as number | undefined;
        if (!uid || typeof tsRaw !== 'number') continue;
        actionRows.push({
          id: `${h.id}:${tsRaw}:${uid}`,
          table_id: h.table_id,
          hand_id: h.id,
          user_id: uid,
          created_at: new Date(tsRaw).toISOString(),
          street: ((a.stage ?? a.street) as string | undefined) ?? null,
          action: (a.action as string | undefined) ?? null,
        });
      }
    }

    const findings: Finding[] = [
      ...scanChipDump(handsRows),
      ...scanSoftPlay(handsRows),
      ...scanTimingCorrelation(actionRows),
      ...scanWinRateAnomaly(handsRows),
    ];

    const scan_date = windowEnd.toISOString().split('T')[0]!;
    const rows = findings.map((f) => ({
      ...f,
      scan_date,
      window_start: windowStart.toISOString(),
      window_end: windowEnd.toISOString(),
      status: 'open',
    }));

    let inserted = 0;
    if (rows.length > 0) {
      const { error: insErr, count } = await supabase
        .from('collusion_tracking')
        .insert(rows, { count: 'exact' });
      if (insErr) {
        console.warn('[collusion-scan] insert error:', insErr.message);
        return c.json({ error: insErr.message, findings: rows.length }, 500);
      }
      inserted = count ?? rows.length;
    }

    const durationMs = Date.now() - scanStart;
    return c.json({
      success: true,
      scanned_hands: handsRows.length,
      scanned_actions: actionRows.length,
      findings: findings.length,
      inserted,
      window: {
        start: windowStart.toISOString(),
        end: windowEnd.toISOString(),
      },
      duration_ms: durationMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'scan failed';
    console.warn('[collusion-scan] fatal:', msg);
    return c.json({ error: msg }, 500);
  }
}
