import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(()=>({data:[] as unknown[]|null,error:null as {message:string}|null,throws:false,reads:0}));
vi.mock('../supabase.js',()=>({getSupabase:()=>({from:()=>{
  const chain={select:()=>chain,eq:()=>chain,order:()=>chain,limit:()=>chain,abortSignal:async()=>{
    db.reads++;if(db.throws)throw new Error('offline');return {data:db.data,error:db.error};}};return chain;
}})}));
import { balancedVideoPriority, balancedVideoTypes, readRecentVideoContext, videoFeedConcentration } from './VideoFeedBalance.js';
import type { SupplyClip } from './ClipSupply.js';
const clip=(title:string,source='PokerGO',duration=60):SupplyClip=>({id:'clip',video_id:'AAAAAAAAAAA',source_url:'https://youtube.com/watch?v=AAAAAAAAAAA',source,title,category:'poker',oembed_ok:true,duration_seconds:duration});
beforeEach(()=>{db.data=[];db.error=null;db.throws=false;db.reads=0;});
describe('bounded source and subject variety',()=>{
  it('stays poker-first normally, but diversifies repeated guarantee coverage across approved categories',()=>{
    const supply={poker:[clip('$2 million guarantee bounty prize')],sports:[clip('LeBron James dunks','NBA')]};
    expect(balancedVideoTypes(['poker','sports'],supply,[])).toEqual(['poker','sports']);
    expect(balancedVideoTypes(['poker','sports'],supply,[{title:'$1 million guarantee bounty prize',source:'PokerGO',topic:'poker'}])).toEqual(['sports','poker']);
    expect(balancedVideoTypes(['poker'],supply,[{title:'$1 million guarantee bounty prize',source:'PokerGO',topic:'poker'}])).toEqual(['poker']);
  });
  it('deprioritizes another prize guarantee in favor of a real different short',()=>{
    const recent=[{title:'$1 million guarantee at a bounty tournament',source:'PokerGO',topic:'poker'}];
    expect(balancedVideoPriority(clip('$2 million guarantee with a bounty prize'),'poker',recent,true))
      .toBeGreaterThan(balancedVideoPriority(clip('Pocket aces in a four-way pot','World Poker Tour'),'poker',recent,false));
  });
  it('keeps verified shorts ahead of a diverse long broadcast',()=>{
    const recent=Array.from({length:12},()=>({title:'$1 million guarantee bounty prize',source:'PokerGO',topic:'poker'}));
    expect(balancedVideoPriority(clip('$2 million guarantee bounty prize'),'poker',recent,false))
      .toBeLessThan(balancedVideoPriority(clip('A river bluff with pocket aces','New source',3600),'poker',recent,true));
  });
  it('penalizes the same named subject and source but never removes candidates',()=>{
    const repeated=clip('Phil Ivey makes a hero call');
    expect(videoFeedConcentration(repeated,'poker',[{title:repeated.title,source:'PokerGO',topic:'poker'}])).toBeGreaterThan(0);
    expect(Number.isFinite(balancedVideoPriority(repeated,'poker',[],true))).toBe(true);
  });
  it('reads preference history once without inventing a complete-history claim',async()=>{
    db.data=[{content:'A river bluff with pocket aces',link_title:null,metadata:{clip_source:'PokerGO',clip_type:'poker'}}];
    expect(await readRecentVideoContext()).toMatchObject({status:'ok',items:[{title:'A river bluff with pocket aces',source:'PokerGO',topic:'poker'}]});
    expect(db.reads).toBe(1);
  });
  it.each(['error','malformed','throws'])('marks %s preference history unknown, without fabricating history',async kind=>{
    if(kind==='error')db.error={message:'offline'};if(kind==='malformed')db.data=null;if(kind==='throws')db.throws=true;
    expect(await readRecentVideoContext()).toMatchObject({status:'unknown',items:[]});
  });
});
