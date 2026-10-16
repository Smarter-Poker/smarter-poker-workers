import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb, type Row } from './testing/fakeSupabase.js';
const state=vi.hoisted(()=>({client:null as unknown}));
vi.mock('../supabase.js',()=>({getSupabase:()=>state.client}));
import { writeCaption } from './VoiceWriter.js';
import { tagCandidateFor } from './FriendGraph.js';
import { briefForAsset } from './PostBrief.js';

// Actual tagged source/target pair and public profile read on 2026-10-16.
const horse={profile_id:'a1bf8c9f-ad73-4e20-86cb-f061e3223083',name:'Harbor Pemberton',alias:'EverestGabi',location:'Miami, FL',stakes:'1/3',specialty:'live cash'};
const friend={profile_id:'0097309f-2864-4d09-b02b-56bca012a9c3',name:'Michael Antonov',alias:'AceMerchant',location:'Phoenix, AZ',stakes:'1/3',specialty:'mixed games'};
const profile={id:friend.profile_id,username:'florenciasid9ba',display_name:'Florencia Siddiqui',is_horse:true};
const asset={kind:'link' as const,title:'Brewers sweep Dodgers in NLCS, advance to 1st World Series in 44 years',source:'ESPN News',domainHint:'sports' as const};
let db:FakeDb;
beforeEach(()=>{db=new FakeDb();state.client=db.client;db.seed('profiles',[profile]);});

async function withoutTag(){return writeCaption(horse,asset,[]);}

describe('optional tags resolve the actual public horse identity',()=>{
  it('keeps the real friend selection and reason, but displays the current public name and handle',async()=>{
    const brief=briefForAsset(asset);
    const candidate=tagCandidateFor(horse,[friend],{domain:brief.domain,concepts:brief.concepts,sport:brief.sport},`${horse.profile_id}:${brief.title}`);
    expect(candidate).toEqual({friend,reason:'same stakes (1/3)'});
    const original=await withoutTag();
    const written=await writeCaption(horse,asset,[friend]);
    expect(written.text).toBe(`${original.text}\n\nwhat do you think Florencia Siddiqui (@florenciasid9ba)`);
    expect(written.tagged).toEqual({alias:'florenciasid9ba',reason:candidate!.reason});
    expect(written.text).not.toMatch(/AceMerchant|Michael Antonov/);
    expect(written.semanticKey).toBe(original.semanticKey);
    expect(db.log.filter(op=>op.table==='profiles')).toHaveLength(1);
    expect(db.log.find(op=>op.table==='profiles')?.filters).toEqual(['eq:id','eq:is_horse']);
    expect(db.log.every(op=>op.kind==='select')).toBe(true);
  });
  it.each([
    ['missing',null],
    ['not a horse',{...profile,is_horse:false}],
    ['no username',{...profile,username:null}],
    ['username with spaces',{...profile,username:'Florencia Siddiqui'}],
    ['username markup',{...profile,username:'<script>'}],
    ['username punctuation',{...profile,username:'florencia/siddiqui'}],
    ['username truncated by renderer',{...profile,username:'f'.repeat(31)}],
    ['single character username',{...profile,username:'f'}],
    ['trailing period',{...profile,username:'florencia.'}],
    ['legacy poker handle',{...profile,username:'aCEmERCHANT'}],
    ['no public name',{...profile,display_name:null}],
    ['empty public name',{...profile,display_name:' '}],
    ['name is old poker alias',{...profile,display_name:'AceMerchant'}],
    ['unsafe name mention',{...profile,display_name:'Florencia @Someone'}],
    ['unsafe name newline',{...profile,display_name:'Florencia\nSiddiqui'}],
    ['unsafe name markup',{...profile,display_name:'<Florencia>'}],
  ])('omits the optional %s tag and preserves the qualified caption',async(_label,value)=>{
    db.tables.profiles=value?[value as Row]:[];
    const original=await withoutTag();
    const written=await writeCaption(horse,asset,[friend]);
    expect(written.text).toBe(original.text);
    expect(written.semanticKey).toBe(original.semanticKey);
    expect(written.tagged).toBeUndefined();
  });
  it('omits an unreadable profile without swallowing or replacing the caption',async()=>{
    db.fail(op=>op.table==='profiles',{message:'permission denied',code:'42501'});
    const original=await withoutTag();
    expect((await writeCaption(horse,asset,[friend])).text).toBe(original.text);
  });
  it('omits a thrown profile read without failing the otherwise qualified caption',async()=>{
    const original=await withoutTag();
    state.client={from:(table:string)=>{if(table==='profiles')throw new Error('transport failure');return db.client.from(table);}};
    const written=await writeCaption(horse,asset,[friend]);
    expect(written.text).toBe(original.text);
    expect(written.tagged).toBeUndefined();
  });
  it('does not generate a handle when the legacy alias is absent',async()=>{
    const written=await writeCaption(horse,asset,[{...friend,alias:null}]);
    expect(written.tagged?.alias).toBe(profile.username);
    expect(written.text).toContain('Florencia Siddiqui (@florenciasid9ba)');
  });
});
