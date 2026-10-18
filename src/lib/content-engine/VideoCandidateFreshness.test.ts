import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ used: new Set<string>(), error: false, truncated: false, malformed: false,
  failures: [] as Array<{status?: number; code?: string; throws?: boolean; message?: string}>,
  persistent: null as {status?: number; code?: string; throws?: boolean; message?: string} | null,
  reads: [] as Array<{table:string;column:string;keys:string[];mine:boolean;since:string}> }));
vi.mock('../supabase.js',()=>({getSupabase:()=>({from:(table:string)=>{
  const read={table,column:'',keys:[] as string[],mine:false,since:''};
  const chain={select:(column:string)=>{read.column=column;return chain;},
    in:(_column:string,keys:string[])=>{read.keys=keys;return chain;},
    gte:(_column:string,since:string)=>{read.since=since;return chain;},
    eq:()=>{read.mine=true;return chain;},limit:()=>chain,
    abortSignal:async()=>{db.reads.push(read);
      const failure=db.failures.shift() ?? db.persistent;
      if(failure?.throws)throw Object.assign(new Error(failure.message ?? 'Socket failure'),{cause:{code:failure.code}});
      if(failure)return {status:failure.status ?? 0,data:null,error:{message:failure.message ?? 'Read unavailable',code:failure.code}};
      return {error:db.error?{message:'offline'}:null,
      data:db.malformed?[{[read.column]:'foreign-key'}]:db.truncated?Array.from({length:1000},()=>({[read.column]:read.keys[0]})):
        read.keys.filter(key=>db.used.has(`${table}:${key}`)).map(key=>({[read.column]:key}))};},
  };return chain;
}})}));
import { freshVideoCaptionCandidates, videoCandidateMeanings, VIDEO_FRESHNESS_KEY_CHUNK } from './VideoCandidateFreshness.js';
import type { SupplyClip } from './ClipSupply.js';
const profile='00000000-0000-4000-8000-000000000001';
const clip=(index:number,title='Navigating a five-way all-in'):SupplyClip=>({id:String(index),video_id:`Factual000${index}`,
  source_url:`https://www.youtube.com/watch?v=Factual000${index}`,source:'PokerGO',title,category:'poker',oembed_ok:true,duration_seconds:60});
beforeEach(()=>{db.used.clear();db.error=false;db.truncated=false;db.malformed=false;db.reads=[];db.failures=[];db.persistent=null;});
describe('bounded semantic screening before video selection',()=>{
  it('separates no grounded draft from used meaning without relabeling either fresh',async()=>{
    const stale=clip(0),unwritable=clip(1,'Keyboard shortcuts'),fresh=clip(2,'Pocket aces in a four-way pot');
    for(const key of videoCandidateMeanings(stale,'poker',profile))db.used.add(`horse_semantic_ledger:${key}`);
    expect(await freshVideoCaptionCandidates([stale,unwritable,fresh],'poker',profile))
      .toMatchObject({status:'ok',scanned:3,stale:2,ungroundable:1,reused:1,clips:[fresh]});
    expect(await freshVideoCaptionCandidates([unwritable],'poker',profile))
      .toMatchObject({status:'ok',scanned:1,stale:1,ungroundable:1,reused:0,keys:0});
  });
  it('keeps an actual new sports passing context distinct from exhausted generic three-point commentary',async()=>{
    const passing={...clip(0),title:'Aaron Gordon’s Fancy Handle Finds Cam Johnson for the Open Three',source:'NBA',category:'highlight',sport_type:'nba'};
    db.used.add('horse_semantic_ledger:meaning:confidence on a three like that is half the shot');
    db.used.add('horse_phrase_ledger:meaning:a three like that takes the air out of a building');
    const keys=videoCandidateMeanings(passing,'sports',profile);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every(key=>key.includes(':basketball_passing_context:'))).toBe(true);
    expect(await freshVideoCaptionCandidates([passing],'sports',profile)).toMatchObject({status:'ok',clips:[passing],reused:0,ungroundable:0});
    for(const key of keys)db.used.add(`horse_semantic_ledger:${key}`);
    expect(await freshVideoCaptionCandidates([passing],'sports',profile)).toMatchObject({status:'ok',clips:[],reused:1,ungroundable:0});
  });
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
  it('screens a fact-diverse bounded catalogue beyond the former 120-key ceiling',async()=>{
    const clips=Array.from({length:130},(_,i)=>clip(i,`He Put $${i+1} Into a $1000 Pot!`));
    const staleKeys=clips.slice(0,129).flatMap(c=>videoCandidateMeanings(c,'poker',profile));
    expect(new Set(staleKeys).size).toBeGreaterThan(120);
    for(const key of staleKeys)db.used.add(`horse_semantic_ledger:${key}`);
    expect(await freshVideoCaptionCandidates(clips,'poker',profile)).toMatchObject({status:'ok',clips:[clips[129]],scanned:130,stale:129});
    expect(db.reads.every(read=>read.keys.length<=VIDEO_FRESHNESS_KEY_CHUNK)).toBe(true);
  });
  it.each([502,503,504])('repeats only the failed SELECT once after HTTP %s',async status=>{
    db.failures=[{status}];
    const result=await freshVideoCaptionCandidates([clip(0)],'poker',profile);
    expect(result).toMatchObject({status:'ok',clips:[clip(0)]});
    expect(db.reads).toHaveLength(5);
    expect(db.reads[4]).toEqual(db.reads[0]);
  });
  it.each(['ECONNRESET','ETIMEDOUT','UND_ERR_SOCKET'])('recovers a structured %s SELECT failure once',async code=>{
    db.failures=[{throws:true,code}];
    expect(await freshVideoCaptionCandidates([clip(0)],'poker',profile)).toMatchObject({status:'ok',clips:[clip(0)]});
    expect(db.reads).toHaveLength(5);
  });
  it('keeps a second transient read failure unknown and never makes a third attempt',async()=>{
    db.persistent={status:502};
    expect(await freshVideoCaptionCandidates([clip(0)],'poker',profile)).toMatchObject({status:'unknown'});
    expect(db.reads).toHaveLength(8);
  });
  it.each([400,401,403,429,500])('never repeats a non-transient HTTP %s refusal',async status=>{
    db.persistent={status};
    expect(await freshVideoCaptionCandidates([clip(0)],'poker',profile)).toMatchObject({status:'unknown'});
    expect(db.reads).toHaveLength(4);
  });
  it('does not mistake error-message words for a structured retryable failure',async()=>{
    db.persistent={message:'502 socket ECONNRESET unavailable'};
    expect(await freshVideoCaptionCandidates([clip(0)],'poker',profile)).toMatchObject({status:'unknown'});
    expect(db.reads).toHaveLength(4);
  });
});
