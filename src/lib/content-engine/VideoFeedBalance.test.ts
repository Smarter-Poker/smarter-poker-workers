import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(()=>({data:[] as unknown[]|null,error:null as {message:string}|null,throws:false,reads:0}));
vi.mock('../supabase.js',()=>({getSupabase:()=>({from:()=>{
  const chain={select:()=>chain,eq:()=>chain,order:()=>chain,limit:()=>chain,abortSignal:async()=>{
    db.reads++;if(db.throws)throw new Error('offline');return {data:db.data,error:db.error};}};return chain;
}})}));
import {
  balancedVideoPriority,
  balancedVideoTypes,
  canPublishQuoteCardVideo,
  isQuoteCardVideoClip,
  isQuoteCardVideoContext,
  QUOTE_CARD_MAX_HORSES,
  QUOTE_CARD_MIN_GAP_POSTS,
  quoteCardAllowedHorses,
  readRecentVideoContext,
  recentHasQuoteCard,
  videoFeedConcentration,
} from './VideoFeedBalance.js';
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

describe('quote-card video cohort and anti-back-to-back laws', () => {
  const fleet1000 = Array.from({ length: 1000 }, (_, i) => ({
    profile_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  }));

  it('identifies Phil Galfond quote-card clips case-insensitively and leaves poker-table sources alone', () => {
    expect(isQuoteCardVideoClip({ source: 'Phil Galfond' })).toBe(true);
    expect(isQuoteCardVideoClip({ source: '  phil galfond  ' })).toBe(true);
    expect(isQuoteCardVideoContext({ source: 'Phil Galfond' })).toBe(true);
    expect(isQuoteCardVideoClip({ source: 'PokerGO' })).toBe(false);
    expect(isQuoteCardVideoClip({ source: 'Mariano' })).toBe(false);
    expect(isQuoteCardVideoClip({ source: null })).toBe(false);
  });

  it('restricts quote-card videos to a deterministic cohort of at most 3 horses across a 1,000-horse fleet and fails closed on empty fleet', () => {
    expect(QUOTE_CARD_MAX_HORSES).toBe(3);
    const allowed = quoteCardAllowedHorses(fleet1000);
    expect(allowed.size).toBe(3);
    // Deterministic regardless of input order
    const reversed = quoteCardAllowedHorses([...fleet1000].reverse());
    expect([...allowed]).toEqual([...reversed]);
    // Fails closed on empty fleet
    expect(quoteCardAllowedHorses([]).size).toBe(0);
    // Never exceeds QUOTE_CARD_MAX_HORSES even if caller requests more
    expect(quoteCardAllowedHorses(fleet1000, 99).size).toBe(3);
  });

  it('forbids back-to-back or clustered quote-card posts within QUOTE_CARD_MIN_GAP_POSTS', () => {
    const galfond = { title: 'Luck vs skill', source: 'Phil Galfond', topic: 'poker' };
    const table = { title: 'River bluff', source: 'PokerGO', topic: 'poker' };
    expect(recentHasQuoteCard([galfond])).toBe(true);
    expect(recentHasQuoteCard([table, table, table, table, galfond])).toBe(true);
    expect(recentHasQuoteCard(Array.from({ length: QUOTE_CARD_MIN_GAP_POSTS }, () => table).concat(galfond))).toBe(false);
    expect(recentHasQuoteCard([])).toBe(false);
  });

  it('enforces all four quote-card gate invariants fail-closed', () => {
    const allowed = quoteCardAllowedHorses(fleet1000);
    const allowedId = [...allowed][0]!;
    const disallowedId = fleet1000.find((h) => !allowed.has(h.profile_id))!.profile_id;
    const table = { title: 'River bluff', source: 'PokerGO', topic: 'poker' };
    const galfond = { title: 'Luck vs skill', source: 'Phil Galfond', topic: 'poker' };

    // Allowed cohort horse with clean recent feed passes
    expect(canPublishQuoteCardVideo({
      profileId: allowedId,
      fleet: fleet1000,
      recent: [table, table],
      recentStatus: 'ok',
      quoteCardPostedInRun: 0,
    })).toBe(true);

    // Non-cohort horse is ALWAYS blocked
    expect(canPublishQuoteCardVideo({
      profileId: disallowedId,
      fleet: fleet1000,
      recent: [],
      recentStatus: 'ok',
      quoteCardPostedInRun: 0,
    })).toBe(false);

    // Recent quote-card post blocks even an allowed cohort horse (never back-to-back)
    expect(canPublishQuoteCardVideo({
      profileId: allowedId,
      fleet: fleet1000,
      recent: [galfond],
      recentStatus: 'ok',
      quoteCardPostedInRun: 0,
    })).toBe(false);

    // Already posted 1 quote-card video in this run blocks a 2nd
    expect(canPublishQuoteCardVideo({
      profileId: allowedId,
      fleet: fleet1000,
      recent: [],
      recentStatus: 'ok',
      quoteCardPostedInRun: 1,
    })).toBe(false);

    // Unknown recent feed status fails closed
    expect(canPublishQuoteCardVideo({
      profileId: allowedId,
      fleet: fleet1000,
      recent: [],
      recentStatus: 'unknown',
      quoteCardPostedInRun: 0,
    })).toBe(false);
  });
});
