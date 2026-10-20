import {beforeEach, afterEach, describe, expect, it, vi} from 'vitest';

type Row = Record<string, unknown>;
const db=vi.hoisted(()=>({tables:{} as Record<string,Row[]>,reads:[] as Array<{table:string;select:string}>,failSelect:'',frameReads:0,frameCountOverride:undefined as number|null|undefined}));
vi.mock('../supabase.js',()=>({
  getSupabase:()=>({from:(table:string)=>{
    const predicates:Array<(row:Row)=>boolean>=[];
    let columns='*',limit=Infinity,order='',counted=false;
    const query:Record<string,unknown>={
      select:(value:string,options?:{count?:string})=>{columns=value;counted=options?.count==='exact';return query;},
      eq:(key:string,value:unknown)=>{predicates.push(row=>String(row[key])===String(value));return query;},
      in:(key:string,values:unknown[])=>{predicates.push(row=>values.map(String).includes(String(row[key])));return query;},
      gte:(key:string,value:string)=>{predicates.push(row=>String(row[key])>=value);return query;},
      like:(key:string,value:string)=>{predicates.push(row=>String(row[key]).startsWith(value.replace(/%$/,'')));return query;},
      order:(key:string)=>{order=key;return query;},
      limit:(value:number)=>{limit=value;return query;},
      then:(resolve:(value:unknown)=>unknown,reject:(error:unknown)=>unknown)=>{
        db.reads.push({table,select:columns});
        if(table==='horse_phrase_ledger'&&counted)db.frameReads++;
        if(db.failSelect&&columns===db.failSelect)return Promise.resolve({data:null,error:{message:'unreadable source'}}).then(resolve,reject);
        let rows=(db.tables[table]??[]).filter(row=>predicates.every(p=>p(row)));
        const count=rows.length;
        if(order)rows=[...rows].sort((a,b)=>String(b[order]).localeCompare(String(a[order])));
        rows=rows.slice(0,limit);
        const selected=columns==='*'?rows:rows.map(row=>Object.fromEntries(columns.split(',').map(key=>[key.trim(),row[key.trim()]])));
        return Promise.resolve({data:selected,error:null,status:200,count:counted?(db.frameCountOverride===undefined?count:db.frameCountOverride):null}).then(resolve,reject);
      },
    };
    return query;
  }}),
}));

import {pickHandStory, pickHandStories} from './HandStory.js';
import {writeGrounded, type AuthorHorse} from './VoiceWriter.js';
import {lineFor} from './HandVoice.js';
import {normalizePhrase} from './ContentLedger.js';

const HORSE='11111111-1111-4111-8111-111111111111';
const HAND_ONE='22222222-2222-4222-8222-222222222222';
const HAND_TWO='33333333-3333-4333-8333-333333333333';
const author={profile_id:HORSE,name:'fixture horse'} as AuthorHorse;
const row=(id:string,handId:string):Row=>({
  id,hand_id:handId,horse_user_id:HORSE,review_status:'auto_reviewed',played_at:'2026-10-19T10:00:00Z',
  game_variant:'nlh',format:'cash',big_blind:2,
  hole_cards:[{rank:'A',suit:'hearts'},{rank:'A',suit:'clubs'}],
  board:[{rank:'K',suit:'clubs'},{rank:'7',suit:'hearts'},{rank:'2',suit:'diamonds'}],
  net_bb:80,pot_size:200,is_win:true,leak_tags:[],
  actions:[
    {userId:HORSE,stage:'flop',action:'bet',amount:80},
    {userId:'private-opponent-uuid',stage:'flop',action:'fold',amount:0,privateCards:['Qs','Qd'],displayName:'Private Opponent'},
  ],
});
const ledger=(phrase:string):Row=>({id:1,phrase_norm:phrase,horse_id:'another horse',used_at:'2026-10-19T11:00:00Z'});

describe('completed own-hand selection and canonical freshness',()=>{
  beforeEach(()=>{
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));
    db.tables={horse_hand_reviews:[row('9001',HAND_ONE),row('9002',HAND_TWO)],hand_history:[
      {id:HAND_ONE,ended_at:'2026-10-19T10:00:00Z'},{id:HAND_TWO,ended_at:'2026-10-19T10:00:00Z'},
    ]};db.reads=[];db.failSelect='';db.frameReads=0;db.frameCountOverride=undefined;
  });
  afterEach(()=>vi.useRealTimers());

  it('uses the actual hand UUID for source freshness and keeps the review row identifier separate',async()=>{
    db.tables.horse_hand_reviews=[row('9001',HAND_ONE)];
    const out=await writeGrounded(author,{hand:true,session:false});
    expect(out?.semanticKey).toBe(`grounded:hand:${HAND_ONE}`);
    expect(out?.handReviewId).toBe('9001');
    expect(out?.grounding).toContain(`hand:${HAND_ONE}`);
    expect(JSON.stringify(out)).not.toMatch(/private-opponent-uuid|Private Opponent|privateCards|Qs|Qd/);
  });
  it('preserves a valid bigint review string without rounding it through JavaScript numbers',async()=>{
    db.tables.horse_hand_reviews=[row('9223372036854775807',HAND_ONE)];
    const out=await writeGrounded(author,{hand:true,session:false});
    expect(out?.handReviewId).toBe('9223372036854775807');
    expect(out?.semanticKey).toBe(`grounded:hand:${HAND_ONE}`);
  });
  it('canonicalizes case and deduplicates two reviews of the same actual hand',async()=>{
    db.tables.horse_hand_reviews=[row('9001',HAND_ONE.toUpperCase()),row('9002',HAND_ONE)];
    const hands=await pickHandStories(HORSE);
    expect(hands).toHaveLength(1);
    expect(hands[0]!.handId).toBe(HAND_ONE);
  });
  it('keeps selection bounded to twelve sources and reads their actions in one batch',async()=>{
    db.tables.horse_hand_reviews=Array.from({length:20},(_,i)=>row(String(9001+i),`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`));
    db.tables.hand_history=db.tables.horse_hand_reviews.map(review=>({id:review.hand_id,ended_at:'2026-10-19T10:00:00Z'}));
    const hands=await pickHandStories(HORSE);
    expect(hands).toHaveLength(12);
    expect(db.reads.filter(read=>read.table==='horse_hand_reviews')).toHaveLength(2);
    expect(db.reads.filter(read=>read.table==='hand_history')).toEqual([{table:'hand_history',select:'id, ended_at'}]);
  });

  it('tries a sibling candidate when the first valid hand was already told by another author',async()=>{
    const first=await pickHandStory(HORSE);
    db.tables.horse_phrase_ledger=[ledger(`grounded:hand:${first!.handId}`)];db.reads=[];
    const out=await writeGrounded(author,{hand:true,session:false});
    expect(out?.text).toBeTruthy();
    expect(out?.semanticKey).not.toBe(`grounded:hand:${first!.handId}`);
    expect(out?.semanticKey).toMatch(/^grounded:hand:[0-9a-f-]{36}$/);
    expect(db.reads.filter(read=>read.table==='horse_hand_reviews'&&read.select.includes('actions'))).toHaveLength(1);
    expect(db.frameReads).toBe(1);
  });

  it('tries another category when all frames for the first hand are occupied',async()=>{
    const first=await pickHandStory(HORSE);
    const other=db.tables.horse_hand_reviews.find(review=>String(review.id)!==String(first!.handId)&&review.hand_id!==first!.handId)!;
    // Turn the other hand into a genuine fold: its category has a separate
    // authored frame pool, so occupied winning-hand frames cannot starve it.
    other.is_win=false;other.net_bb=-80;other.actions=[{userId:HORSE,stage:'flop',action:'fold',amount:0}];
    db.tables.horse_phrase_ledger=Array.from({length:200},(_,i)=>ledger(`frame:voice:${first!.category}:${i}`));
    const out=await writeGrounded(author,{hand:true,session:false});
    expect(out?.text).toBeTruthy();
    expect(out?.grounding).toContain('category:big_fold');
  });

  it('tries another hand when every available sentence for the first hand was already used',async()=>{
    const first=await pickHandStory(HORSE);
    const used=new Set<string>();const phrases:Row[]=[];
    for(let i=0;i<200;i++){
      const spoken=lineFor(first!,`${HORSE}:h:${first!.handId}`,used);
      if(!spoken)break;
      used.add(spoken.key);phrases.push(ledger(normalizePhrase(spoken.text)));
    }
    expect(phrases.length).toBeGreaterThan(0);
    // Give the sibling a different holding so its grounded sentences differ.
    for(const review of db.tables.horse_hand_reviews)if(String(review.id)!==String(first!.handId)&&review.hand_id!==first!.handId)
      review.hole_cards=[{rank:'Q',suit:'hearts'},{rank:'Q',suit:'clubs'}];
    db.tables.horse_phrase_ledger=phrases;
    const out=await writeGrounded(author,{hand:true,session:false});
    expect(out?.text).toBeTruthy();
    expect(phrases.map(p=>p.phrase_norm)).not.toContain(normalizePhrase(out!.text));
    expect(db.frameReads).toBe(1);
  });

  it('uses recent focus from another category instead of repeating a showdown loss',async()=>{
    const review=row('9001',HAND_ONE);
    review.game_variant='plo4';review.is_win=false;review.net_bb=-80;review.leak_tags=['dominated_straight'];
    review.actions=[{userId:HORSE,stage:'river',action:'check',amount:0},{userId:'private-opponent-uuid',stage:'river',action:'check',amount:0}];
    db.tables.horse_hand_reviews=[review];
    db.tables.horse_phrase_ledger=[ledger('frame:voice:bad_beat:4')];
    const out=await writeGrounded(author,{hand:true,session:false});
    expect(out?.grounding).toContain('category:cooler');
    expect(['frame:voice:cooler:1','frame:voice:cooler:2','frame:voice:cooler:5','frame:voice:cooler:7','frame:voice:cooler:9']).not.toContain(out?.frameKey);
    expect(out?.text).toBeTruthy();expect(db.frameReads).toBe(1);
  });

  it.each([null,1001])('abandons a hand draft if exact family count is missing or truncated: %s',async count=>{
    db.frameCountOverride=count;
    expect(await writeGrounded(author,{hand:true,session:false})).toBeNull();
    expect(db.frameReads).toBe(1);
  });
  it('does not query hand frames when there are no source candidates',async()=>{
    db.tables.horse_hand_reviews=[];
    expect(await writeGrounded(author,{hand:true,session:false})).toBeNull();
    expect(db.frameReads).toBe(0);
  });
  it('abandons the hand draft on a frame family read error',async()=>{
    db.failSelect='phrase_norm';
    expect(await writeGrounded(author,{hand:true,session:false})).toBeNull();
    expect(db.frameReads).toBe(1);
  });

  it.each([
    {hand_id:null},{hand_id:'9001'},{review_status:'pending'},
    {played_at:'2026-10-01T10:00:00Z'},{played_at:'2026-10-20T10:00:00Z'},
    {hole_cards:[{rank:'X',suit:'clubs'},{rank:'A',suit:'hearts'}]},
    {is_win:null},{net_bb:'NaN'},{actions:null},
    {id:0},{id:9007199254740992},{id:'9223372036854775808'},
  ])('refuses an unqualified source row %j',async change=>{
    db.tables.horse_hand_reviews=[{...row('9001',HAND_ONE),...change}];
    expect(await writeGrounded(author,{hand:true,session:false})).toBeNull();
  });

  it('refuses unreadable action data without a draft',async()=>{
    db.failSelect='id, actions';
    expect(await writeGrounded(author,{hand:true,session:false})).toBeNull();
  });
  it.each([null,'2026-10-20T10:00:00Z','not a timestamp'])('refuses a hand without a completed history timestamp: %s',async endedAt=>{
    db.tables.horse_hand_reviews=[row('9001',HAND_ONE)];
    db.tables.hand_history=[{id:HAND_ONE,ended_at:endedAt}];
    expect(await writeGrounded(author,{hand:true,session:false})).toBeNull();
  });
  it('refuses a missing or unreadable completed-hand history',async()=>{
    db.tables.hand_history=[];
    expect(await writeGrounded(author,{hand:true,session:false})).toBeNull();
    db.failSelect='id, ended_at';
    expect(await writeGrounded(author,{hand:true,session:false})).toBeNull();
  });
});
