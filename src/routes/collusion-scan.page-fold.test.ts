import { beforeEach, describe, expect, it, vi } from 'vitest';
import { legacyCollusionTiming } from '../../scripts/ci/collusion-timing-reference.js';
import { collusionScan, TimingCorrelationAccumulator } from './collusion-scan.js';

type Action = Parameters<TimingCorrelationAccumulator['addHand']>[0][number];
const fixture = vi.hoisted(() => ({ hands: [] as Record<string, unknown>[], inserted: [] as Record<string, unknown>[], failRead: false }));
vi.mock('../lib/scanWindow.js', () => ({
  ScanWindowError: class extends Error {},
  resolveScanWindow: async () => ({start:new Date('2026-10-26T00:00Z'),end:new Date('2026-10-27T00:00Z'),overridden:true,dryRun:false}),
}));
vi.mock('../lib/supabase.js', () => ({ getSupabase: () => ({from: () => ({
  insert: async (rows: Record<string, unknown>[]) => { fixture.inserted=rows;return {error:null,count:rows.length}; },
})}) }));
vi.mock('../lib/pagedSelectKeyset.js', () => ({
  pagedSelectKeyset: async (_build: unknown, opts: {onPage:(rows: Record<string, unknown>[])=>void}) => {
    if(fixture.failRead)throw new Error('original read refused');
    for(let i=0;i<fixture.hands.length;i+=13)opts.onPage(fixture.hands.slice(i,i+13));
    return {complete:false,hitBudget:true,cursorEnd:'2026-10-26T01:00Z',pages:8};
  },
}));
function actions(hand:number): Action[] {
 const start=1700000000000+hand*100000;
 return Array.from({length:20},(_,i)=>({id:`${hand}:${i}`,hand_id:`hand-${hand}`,table_id:'table',
   user_id:`user-${(hand%10)*2+i%2}`,created_at:new Date(start+i*(hand%10===0?100:1000)).toISOString(),street:'flop',action:'check'}));
}
beforeEach(()=>{fixture.hands=[];fixture.inserted=[];fixture.failRead=false;});
describe('collusion timing is folded at the actual route page boundary',()=>{
 it('preserves positive findings, population, counts and incomplete-read semantics across pages',async()=>{
   const all: Action[]=[];
   for(let h=0;h<100;h++){
     const rows=actions(h);all.push(...rows);
     fixture.hands.push({id:`hand-${h}`,table_id:'table',created_at:'2026-10-26T00:00Z',players:[],winners:[],actions:rows.map(a=>({user_id:a.user_id,timestamp:Date.parse(a.created_at),stage:'flop',action:'check'}))});
   }
   const expected=legacyCollusionTiming(all);
   expect(expected.length).toBeGreaterThan(0);
   const json=vi.fn((value:unknown,status?:number)=>({value,status}));
   await collusionScan({json} as never);
   expect(json).toHaveBeenLastCalledWith(expect.objectContaining({success:true,scanned_hands:100,scanned_actions:2000,read_complete:false,read_budget_hit:true,hands_truncated:true,covered_to:null}));
   expect(fixture.inserted.map(({scan_date,window_start,window_end,status,...finding})=>finding)).toEqual(expected);
 });
 it('preserves the read failure and writes no findings',async()=>{
   fixture.failRead=true;const json=vi.fn();await collusionScan({json} as never);
   expect(json).toHaveBeenCalledWith({error:'original read refused'},500);expect(fixture.inserted).toEqual([]);
 });
 it('matches the independent old oracle for reordered timestamps and same-actor or absent actors',()=>{
   const groups=Array.from({length:100},(_,h)=>actions(h).reverse());
   groups[0]!.push({...groups[0]![0]!,user_id:null});
   const timing=new TimingCorrelationAccumulator();for(const rows of groups)timing.addHand(rows);
   expect(timing.findings()).toEqual(legacyCollusionTiming(groups.flat()));
   expect(timing.actionCount).toBe(2001);
 });
});
