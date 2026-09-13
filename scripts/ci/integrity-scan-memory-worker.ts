import { createHash } from 'node:crypto';
import { getHeapStatistics } from 'node:v8';
import { setImmediate } from 'node:timers/promises';
import { BotTimingAccumulator, ChipDumpAccumulator, timingStats, type TimingHand, type ChipDumpHand } from '../../src/lib/integrityScanAccumulators.js';
import { scanPages } from '../../src/lib/scanPages.js';
import { pagedSelect } from '../../src/lib/pagedSelect.js';
import { legacyTiming, legacyChipDump, timingDecision, pairDecisions } from './integrity-scan-reference.js';

// Production sample (200 recent hands, Sep 13): actions average 5980 bytes,
// maximum 22013. This stress fixture uses ~12KB/action array within that measured
// range. It proves the retained-allocation mechanism, not attribution of every
// other concurrently dispatched handler in the production OOM.
const contextText = 'hand state, legal actions, seat snapshot; '.repeat(35);
function timingHand(i: number): TimingHand {
  return { actions: Array.from({ length: 8 }, (_, j) => ({
    user_id: `user-${(i + Math.floor(j / 4)) % 50}`,
    timestamp: 1700000000000 + i * 100000 + (j % 4) * (100 + i % 7),
    action: j % 4 ? 'call' : 'check', street: 'flop',
    context: `${i}/${j}/${contextText}`,
  })) };
}
function chipHand(i: number): ChipDumpHand {
  return { id: `hand-${i}`, created_at: '2026-09-13T00:00:00Z', pot_size: 600,
    players: Array.from({ length: 6 }, (_, j) => ({
      user_id: `player-${(i % 100) * 6 + j}`, chips_invested: 100 + i % 7,
      chips_won: j === i % 6 ? 600 : 0,
    })), winners: [{ user_id: `player-${(i % 100) * 6 + i % 6}` }],
  };
}

let peakHeap = 0, peakRss = 0;
const sampleMemory = () => { const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss); };
const build = <T>(total: number, make: (i: number) => T) => () => ({
  range: async (from: number, to: number) => {
    // Independent parsed pages model PostgREST's JSON, including its allocation
    // graph. Never prebuild the full fixture outside the scan under test.
    await setImmediate();
    const wire = JSON.stringify(Array.from({ length: Math.max(0, Math.min(total, to + 1) - from) }, (_, j) => make(from + j)));
    const data = JSON.parse(wire); sampleMemory(); return { data, error: null };
  },
}) as never;

const mode = process.argv[2];
const timingTotal = 20000, chipTotal = 50000;
console.log(JSON.stringify({ mode, heapLimitMiB: getHeapStatistics().heap_size_limit / 1048576,
  actionJsonBytes: JSON.stringify(timingHand(0).actions).length, timingTotal, chipTotal }));
let timing: Array<[string, ReturnType<typeof timingDecision>]>;
let pairs: ReturnType<typeof pairDecisions>;
let counts: number[];
const start = Date.now();
if (mode === 'retained') {
  const [t, c] = await Promise.all([
    pagedSelect<TimingHand>(build(timingTotal, timingHand), timingTotal),
    pagedSelect<ChipDumpHand>(build(chipTotal, chipHand), chipTotal),
  ]);
  const oldTiming = legacyTiming(t.rows), oldChip = legacyChipDump(c.rows);
  timing = [...oldTiming].map(([id, stats]) => [id, timingDecision(stats)]);
  pairs = pairDecisions(oldChip.pairs, oldChip.userTotals);
  counts = [t.rows.length, c.rows.length];
} else if (mode === 'streamed') {
  const t = new BotTimingAccumulator(), c = new ChipDumpAccumulator();
  const scans = await Promise.all([
    scanPages<TimingHand>(build(timingTotal, timingHand), timingTotal, (page) => { page.forEach((h) => t.addHand(h)); sampleMemory(); }),
    scanPages<ChipDumpHand>(build(chipTotal, chipHand), chipTotal, (page) => { page.forEach((h) => c.addHand(h)); sampleMemory(); }),
  ]);
  timing = [...t.users].map(([id, moments]) => [id, timingDecision({ count: moments.count, ...timingStats(moments) })]);
  pairs = pairDecisions(c.pairs, c.userTotals);
  counts = scans.map((s) => s.count);
} else throw new Error('Expected retained or streamed');
sampleMemory();
const digest = createHash('sha256').update(JSON.stringify({ timing, pairs, counts })).digest('hex');
console.log(JSON.stringify({ mode, digest, counts, users: timing.length, pairFindings: pairs.length,
  peakHeapMiB: Math.round(peakHeap / 1048576), peakRssMiB: Math.round(peakRss / 1048576), durationMs: Date.now() - start }));
