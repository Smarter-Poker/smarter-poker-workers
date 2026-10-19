import {beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({first:true,session:false,written:{} as Record<string,unknown>,atomic:vi.fn(),evidence:vi.fn(),direct:vi.fn(),caption:vi.fn()}));
vi.mock('./FleetScheduler.js',()=>({fleetHash:(_id:string,salt:string)=>salt==='grounded'?(state.first?0:99):1,isDueForPost:()=>({due:false}),localClock:()=>({})}));
vi.mock('./Fleet.js',()=>({postModeEnabled:async(mode:string)=>mode==='grounded_hand'||(state.session&&mode==='grounded_session')}));
vi.mock('./VoiceWriter.js',()=>({writeGrounded:async()=>state.written,writeCaption:state.caption,summarise:()=> 'Own hand',recordBrief:state.direct}));
vi.mock('./HorseGroundedPublication.js',()=>({publishHorseGroundedAtomically:state.atomic,readHorseGroundedPublicationEvidence:state.evidence}));
vi.mock('../supabase.js',()=>({getSupabase:()=>({from:()=>{
 const q={select:()=>q,eq:()=>q,order:()=>q,gte:()=>q,limit:async()=>({data:[],error:null}),insert:(...args:unknown[])=>{state.direct(...args);return q;},maybeSingle:async()=>({data:{id:'post'},error:null})};return q;
}})}));
vi.mock('./HumanVoiceEngine.js',()=>({seedHorseMemory:vi.fn()}));
vi.mock('./ClipSupply.js',async original=>({...await original<typeof import('./ClipSupply.js')>(),newsSources:async()=>[]}));
vi.mock('./NewsSourceFallback.js',()=>({orderedNewsSources:()=>[]}));
import {publishForHorse} from './HorsePublisher.js';
const horse={id:1,name:'Fixture',profile_id:'11111111-1111-4111-8111-111111111111'};
const opts={slot:'2026-10-19T12',sharedVideoSupply:{poker:[],sports:[]}};
beforeEach(()=>{vi.clearAllMocks();state.first=true;state.session=false;
 state.written={text:'I folded on the river.',handReviewId:'123',groundedKind:'hand',semanticKey:'grounded:hand:22222222-2222-4222-8222-222222222222',frameKey:'voice:big_fold:river',brief:{kind:'hand',domain:'poker'},grounding:['hand'],attempts:1,relevance:1};
 state.atomic.mockResolvedValue({success:true,postId:'post',created:false});
 state.evidence.mockResolvedValue({status:'public_persisted',endpointVerified:false,observedAt:'now'});
});
describe('grounded publication owns its transaction outcome',()=>{
 it('uses the atomic hand boundary and returns replay accounting without direct writes',async()=>{
  expect(await publishForHorse(horse,opts)).toMatchObject({success:true,created:false,postId:'post',publicationEvidence:{status:'public_persisted'}});
  expect(state.atomic).toHaveBeenCalledTimes(1);expect(state.direct).not.toHaveBeenCalled();
 });
 it.each([true,false])('halts an unknown hand outcome when groundedFirst=%s',async first=>{
  state.first=first;state.atomic.mockResolvedValue({success:false,outcome:'unknown',error:'lost ACK'});
  expect(await publishForHorse(horse,opts)).toMatchObject({success:false,outcome:'unknown',error:'lost ACK',groundedPublicationAttempt:{
    authorId:horse.profile_id,reviewId:'123',content:'I folded on the river.',phraseNorm:'i folded on the river',
    semanticKey:'grounded:hand:22222222-2222-4222-8222-222222222222',frameKey:'voice:big_fold:river',
    publicationKey:`fleet:${horse.profile_id}:2026-10-19T12`,brief:{kind:'hand',domain:'poker'},
  }});
  expect(state.atomic).toHaveBeenCalledTimes(1);expect(state.caption).not.toHaveBeenCalled();expect(state.direct).not.toHaveBeenCalled();
 });
 it('retains exact grounded inputs after definite transaction rollback',async()=>{
  state.atomic.mockResolvedValue({success:false,code:'57014',error:'cancelled'});
  expect(await publishForHorse(horse,opts)).toMatchObject({success:false,groundedPublicationAttempt:{reviewId:'123',content:'I folded on the river.',semanticKey:'grounded:hand:22222222-2222-4222-8222-222222222222'}});
  expect(state.atomic).toHaveBeenCalledTimes(1);
 });
 it('refuses a hand missing its source review identity',async()=>{
  delete state.written.handReviewId;
  expect(await publishForHorse(horse,opts)).toMatchObject({success:false});
  expect(state.atomic).not.toHaveBeenCalled();expect(state.direct).not.toHaveBeenCalled();
 });
 it('does not publish a session returned under hand-only approval',async()=>{
  state.written.groundedKind='session';
  expect(await publishForHorse(horse,opts)).toMatchObject({success:false});
  expect(state.atomic).not.toHaveBeenCalled();expect(state.direct).not.toHaveBeenCalled();
 });
});
