import { createHash } from 'node:crypto';
import { getHeapStatistics } from 'node:v8';
import { TimingCorrelationAccumulator } from '../../src/routes/collusion-scan.js';
import { legacyCollusionTiming } from './collusion-timing-reference.js';

type ActionRow = Parameters<TimingCorrelationAccumulator['addHand']>[0][number];
const mode = process.argv[2];
const retained: ActionRow[] = [];
const timing = new TimingCorrelationAccumulator();
let peakHeap = 0;
// 40,000 is the actual route ceiling. Twenty actions is the measured p95 in
// the stuck production window (Oct26, first1,000 hands); max33, mean10.93.
for (let page = 0; page < 40; page++) {
  const wire = JSON.stringify(Array.from({length:1000}, (_, row) => {
    const hand = page * 1000 + row;
    const start = 1700000000000 + hand * 100000;
    return Array.from({length:20}, (_, a) => ({
      id: `${hand}:${start+a*100}:${a%2}`,
      table_id: `aaaaaaaa-0000-0000-0000-${String(hand%100).padStart(12,'0')}`,
      hand_id: `bbbbbbbb-0000-0000-0000-${String(hand).padStart(12,'0')}`,
      user_id: `cccccccc-0000-0000-0000-${String((hand%100)*2+a%2).padStart(12,'0')}`,
      created_at: new Date(start + a*(hand%100<2 ? 100 : 1000)).toISOString(),
      street: 'flop', action: 'check',
    }));
  }));
  const hands = JSON.parse(wire) as ActionRow[][];
  for (const actions of hands) {
    if (mode==='retained') retained.push(...actions);
    else timing.addHand(actions);
  }
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
}
const findings = mode==='retained' ? legacyCollusionTiming(retained) : timing.findings();
console.log(JSON.stringify({heapLimitMiB:getHeapStatistics().heap_size_limit/1048576,
  actions:mode==='retained'?retained.length:timing.actionCount,
  digest:createHash('sha256').update(JSON.stringify(findings)).digest('hex'),
  findings:findings.length,peakHeapMiB:Math.round(peakHeap/1048576)}));
