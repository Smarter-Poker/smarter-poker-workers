import {beforeEach,describe,expect,it,vi} from 'vitest';
const db=vi.hoisted(()=>({rows:[] as Record<string,unknown>[],queries:[] as {table:string;limit:number;source:string[];order:string;active:boolean;valid:boolean}[],fail:'',durationIds:[] as string[]}));
vi.mock('../supabase.js',()=>({getSupabase:()=>({from:(table:string)=>{
  const state={table,limit:1000,source:[] as string[],order:'',active:false,valid:false};
  const q:Record<string,unknown>={};
  q.select=()=>q;q.order=(column:string)=>{state.order=column;return q;};q.limit=(n:number)=>{state.limit=n;return q;};
  q.eq=(column:string,value:unknown)=>{if(column==='is_active'&&value===true)state.active=true;return q;};
  q.not=(column:string,op:string,value:unknown)=>{if(column==='oembed_ok'&&op==='is'&&value===false)state.valid=true;return q;};
  q.in=(column:string,values:string[])=>{if(column==='source')state.source=values;if(column==='youtube_video_id')db.durationIds.push(...values);return q;};
  q.then=(resolve:(value:unknown)=>void)=>{
    if(table==='video_library_videos'){resolve({data:[],error:null});return;}
    db.queries.push(state);
    if(db.fail==='missing'){resolve({data:null,error:null});return;}
    if(db.fail==='throw')throw new Error('transport lost');
    if(db.fail===(state.source.length?'rich':'global')){resolve({data:null,error:{message:'unreadable'}});return;}
    const rows=db.rows.filter(r=>(!state.source.length||state.source.includes(String(r.source)))&&(!state.active||r.is_active===true)&&(!state.valid||r.oembed_ok!==false));
    resolve({data:rows.slice(0,state.limit),error:null});
  };return q;
}})}));
import {platformCandidateClips} from './ClipSupply.js';
const row=(n:number,source='Other approved source')=>({id:`row${n}`,video_id:`v${String(n).padStart(10,'0')}`,source,title:`source title ${n}`,source_url:`https://youtube.com/watch?v=v${String(n).padStart(10,'0')}`,category:'poker',is_active:true,oembed_ok:true});
beforeEach(()=>{db.rows=[];db.queries=[];db.fail='';db.durationIds=[];});
describe('bounded balanced platform source snapshot',()=>{
  it('retains older fact-rich sources crowded out by 1001 newer vague clips without increasing cap',async()=>{
    db.rows=[...Array.from({length:1001},(_,i)=>row(i)),...Array.from({length:5},(_,i)=>({...row(2000+i,'PokerGO'),title:`Phil Ivey river call ${i}`}))];
    const result=await platformCandidateClips('poker');
    expect(result.status).toBe('ok');if(result.status!=='ok')return;
    expect(result.clips).toHaveLength(505);
    expect(result.clips.slice(-5).map(r=>r.id)).toEqual(['row2000','row2001','row2002','row2003','row2004']);
    expect(db.queries.map(q=>q.limit)).toEqual([500,500]);
    expect(db.queries.every(q=>q.active&&q.valid&&q.order==='published_at')).toBe(true);
    expect(db.queries[1]!.source).toEqual(['PokerGO','Bart Hanson','Mariano','GTO Wizard','Phil Galfond','PokerStars']);
  });
  it('deduplicates canonical video identities before duration joins, keeping global representative',async()=>{
    db.rows=[row(1,'PokerGO'),{...row(1,'PokerGO'),id:'duplicate'},row(2)];
    const result=await platformCandidateClips('poker',6);
    expect(result.status).toBe('ok');if(result.status!=='ok')return;
    expect(result.clips.map(r=>r.id)).toEqual(['row1','row2']);
    expect(db.durationIds).toEqual(['v0000000001','v0000000002']);
  });
  it.each(['global','rich'])('refuses partial success if %s read is unknown',async(fail)=>{
    db.rows=[row(1,'PokerGO')];db.fail=fail;
    expect(await platformCandidateClips('poker')).toEqual({status:'unknown',error:'poker_clips platform pool unreadable: unreadable'});
    expect(db.durationIds).toEqual([]);
  });
  it('keeps exactly one global request when limit is one',async()=>{
    db.rows=[row(1),row(2,'PokerGO')];
    const result=await platformCandidateClips('poker',1);
    expect(result.status==='ok'&&result.clips.map(r=>r.id)).toEqual(['row1']);
    expect(db.queries.map(q=>q.limit)).toEqual([1]);
  });
  it.each(['throw','missing'])('retains %s query output as unknown rather than empty supply',async(fail)=>{
    db.fail=fail;
    const result=await platformCandidateClips('poker');
    expect(result.status).toBe('unknown');
    expect(db.durationIds).toEqual([]);
  });
  it('splits odd sports limit finitely and preserves actual created-at ordering contract',async()=>{
    db.rows=[row(1),row(2),row(3,'NBA'),row(4,'MLB')];
    const result=await platformCandidateClips('sports',3);
    expect(result.status).toBe('ok');if(result.status!=='ok')return;
    expect(result.clips.map(r=>r.id)).toEqual(['row1','row3','row4']);
    expect(db.queries.map(q=>q.limit)).toEqual([1,2]);
    expect(db.queries[1]!.source).toEqual(['NBA','MLB']);
    expect(db.queries.every(q=>q.order==='created_at')).toBe(true);
  });
  it('does not admit inactive or oembed-rejected poker rows from the rich half',async()=>{
    db.rows=[{...row(1,'PokerGO'),is_active:false},{...row(2,'PokerGO'),oembed_ok:false},row(3,'PokerGO')];
    const result=await platformCandidateClips('poker');
    expect(result.status==='ok'&&result.clips.map(r=>r.id)).toEqual(['row3']);
  });
});
