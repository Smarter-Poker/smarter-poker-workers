import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ used: new Set<string>(), error: false, truncated: false, malformed: false,
  reads: [] as Array<{table:string;column:string;keys:string[];mine:boolean;since:string}> }));
vi.mock('../supabase.js',()=>({getSupabase:()=>({from:(table:string)=>{
  const read={table,column:'',keys:[] as string[],mine:false,since:''};
  const chain={select:(column:string)=>{read.column=column;return chain;},
    in:(_column:string,keys:string[])=>{read.keys=keys;return chain;},
    gte:(_column:string,since:string)=>{read.since=since;return chain;},
    eq:()=>{read.mine=true;return chain;},limit:()=>chain,
    abortSignal:async()=>{db.reads.push(read);return {error:db.error?{message:'offline'}:null,
      data:db.malformed?[{[read.column]:'foreign-key'}]:db.truncated?Array.from({length:1000},()=>({[read.column]:read.keys[0]})):
        read.keys.filter(key=>db.used.has(`${table}:${key}`)).map(key=>({[read.column]:key}))};},
  };return chain;
}})}));
import { freshVideoCaptionCandidates, videoCandidateMeanings, VIDEO_FRESHNESS_KEY_CHUNK } from './VideoCandidateFreshness.js';
import type { SupplyClip } from './ClipSupply.js';
const profile='00000000-0000-4000-8000-000000000001';
const clip=(index:number,title='Navigating a five-way all-in'):SupplyClip=>({id:String(index),video_id:`Factual000${index}`,
  source_url:`https://www.youtube.com/watch?v=Factual000${index}`,source:'PokerGO',title,category:'poker',oembed_ok:true,duration_seconds:60});
beforeEach(()=>{db.used.clear();db.error=false;db.truncated=false;db.malformed=false;db.reads=[];});
describe('bounded semantic screening before video selection',()=>{
  it('reaches a fresh factual seventh clip rather than cycling six stale known facts',async()=>{
    const stale=Array.from({length:6},(_,index)=>clip(index));
    const fresh=clip(6,'Pocket aces in a four-way pot');
    const meanings=videoCandidateMeanings(stale[0]!,'poker',profile);
    expect(meanings.length).toBeGreaterThan(0);
    for(const key of meanings)db.used.add(`horse_semantic_ledger:${key}`);
    const result=await freshVideoCaptionCandidates([...stale,fresh],'poker',profile);
    expect(result).toMatchObject({status:'ok',clips:[fresh],scanned:7,stale:6});
    expect(db.reads).toHaveLength(4);
    expect(db.reads.every(read=>read.keys.length<=VIDEO_FRESHNESS_KEY_CHUNK)).toBe(true);
    expect(new Set(db.reads.map(read=>`${read.table}:${read.mine}`)).size).toBe(4);
  });
  it('retains legacy semantic keys and never turns styling or an asset identity into new meaning',async()=>{
    const first=clip(0), equivalent=clip(1);
    const keys=videoCandidateMeanings(first,'poker',profile);
    expect(videoCandidateMeanings(equivalent,'poker',profile)).toEqual(keys);
    for(const key of keys)db.used.add(`horse_phrase_ledger:${key}`);
    expect(await freshVideoCaptionCandidates([first,equivalent],'poker',profile)).toMatchObject({status:'ok',clips:[],stale:2});
  });
  it.each(['error','truncated','malformed'] as const)('fails closed on %s ledger results',async kind=>{
    db[kind]=true;
    expect(await freshVideoCaptionCandidates([clip(0)],'poker',profile)).toMatchObject({status:'unknown'});
  });
  it('does not cache an unused result across publication invocations',async()=>{
    expect(await freshVideoCaptionCandidates([clip(0)],'poker',profile)).toMatchObject({status:'ok',clips:[clip(0)]});
    for(const key of videoCandidateMeanings(clip(0),'poker',profile))db.used.add(`horse_semantic_ledger:${key}`);
    expect(await freshVideoCaptionCandidates([clip(0)],'poker',profile)).toMatchObject({status:'ok',clips:[]});
  });
  it('refuses an over-limit snapshot before any database work',async()=>{
    expect(await freshVideoCaptionCandidates(Array.from({length:1001},(_,i)=>clip(i)),'poker',profile)).toMatchObject({status:'unknown'});
    expect(db.reads).toHaveLength(0);
  });
});
