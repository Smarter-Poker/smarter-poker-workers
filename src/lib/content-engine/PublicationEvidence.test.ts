import { beforeEach, describe, expect, it, vi } from 'vitest';
const db=vi.hoisted(()=>({post:{} as Record<string,unknown>,reel:{} as Record<string,unknown>,error:false,throws:false,reads:0}));
vi.mock('../supabase.js',()=>({getSupabase:()=>({from:(table:string)=>{
 const chain={select:()=>chain,eq:()=>chain,limit:()=>chain,abortSignal:async()=>{db.reads++;if(db.throws)throw new Error('timeout');
   return {data:[table==='social_posts'?db.post:db.reel],error:db.error?{message:'offline'}:null};}};return chain;
}})}));
import { publicationDeliverySummary, readHorseVideoPublicationEvidence, readHorseNewsPublicationEvidence } from './PublicationEvidence.js';
const input={postId:'post1',reelId:'reel1',authorId:'horse1',caption:'Real caption',assetKey:'yt:AAAAAAAAAAA'};
beforeEach(()=>{db.error=false;db.throws=false;db.reads=0;
 db.post={id:'post1',author_id:'horse1',content:'Real caption',visibility:'public',is_deleted:false,origin_type:'horse'};
 db.reel={id:'reel1',source_post_id:'post1',author_id:'horse1',caption:'Real caption',origin_type:'horse',is_public:true,
  canonical_asset_key:'youtube:AAAAAAAAAAA',media_status:'ready',rights_status:'embed_only'};});
describe('acknowledgement and public persistence are different evidence',()=>{
 it('reads an exact public news post without demanding a Reel',async()=>{
   Object.assign(db.post,{content_type:'link',link_url:'https://news.example/story',link_title:'Actual story'});
   const evidence=await readHorseNewsPublicationEvidence({...input,linkUrl:'https://news.example/story',linkTitle:'Actual story'});
   expect(evidence).toMatchObject({status:'public_persisted',endpointVerified:false});
   expect(db.reads).toBe(1);
   expect(publicationDeliverySummary([{success:true,created:true,postId:input.postId,publicationEvidence:evidence}]))
     .toMatchObject({created:1,creation_unknown:0,public_persisted:1,visibility_unknown:0});
 });
 it.each(['hidden','deleted','wrong_author','wrong_caption','wrong_url','wrong_title','wrong_origin','wrong_type'])('rejects %s news readback',async kind=>{
   Object.assign(db.post,{content_type:'link',link_url:'https://news.example/story',link_title:'Actual story'});
   const field={hidden:'visibility',deleted:'is_deleted',wrong_author:'author_id',wrong_caption:'content',wrong_url:'link_url',wrong_title:'link_title',wrong_origin:'origin_type',wrong_type:'content_type'}[kind]!;
   db.post[field]=kind==='deleted'?true:'wrong';
   expect(await readHorseNewsPublicationEvidence({...input,linkUrl:'https://news.example/story',linkTitle:'Actual story'})).toMatchObject({status:'not_public'});
 });
 it.each(['error','throws'])('retains unknown news %s without retrying publication',async kind=>{
   db[kind as 'error'|'throws']=true;
   expect(await readHorseNewsPublicationEvidence({...input,linkUrl:'https://news.example/story',linkTitle:'Actual story'})).toMatchObject({status:'unknown'});
   expect(db.reads).toBe(1);
 });
 it('reads the exact pair and reports persisted public state, never endpoint proof',async()=>{
   expect(await readHorseVideoPublicationEvidence(input)).toMatchObject({status:'public_persisted',endpointVerified:false});
   expect(db.reads).toBe(2);
 });
 it.each(['hidden','wrong_author','wrong_asset','wrong_caption','wrong_source_post','not_ready'])('reports %s pair as not public',async kind=>{
   if(kind==='hidden')db.reel.is_public=false;if(kind==='wrong_author')db.post.author_id='other';
   if(kind==='wrong_asset')db.reel.canonical_asset_key='youtube:BBBBBBBBBBB';if(kind==='wrong_caption')db.reel.caption='Other caption';
   if(kind==='wrong_source_post')db.reel.source_post_id='other';if(kind==='not_ready')db.reel.media_status='pending';
   expect(await readHorseVideoPublicationEvidence(input)).toMatchObject({status:'not_public',endpointVerified:false});
 });
 it.each(['error','throws'])('keeps %s readback unknown without any write/retry',async kind=>{
   db[kind as 'error'|'throws']=true;
   expect(await readHorseVideoPublicationEvidence(input)).toMatchObject({status:'unknown',endpointVerified:false});
   expect(db.reads).toBe(2);
 });
 it('separates attempted/acknowledged creation/replay, visibility and missing evidence',()=>{
   expect(publicationDeliverySummary([
     {success:false},{success:true,created:true,postId:'p',reelId:'r',publicationEvidence:{status:'public_persisted',endpointVerified:false,observedAt:'now'}},
     {success:true,created:false},{success:true},
   ])).toMatchObject({acknowledged:3,created:1,replayed:1,creation_unknown:1,public_persisted:1,visibility_unknown:2,endpoint_verified:0,
     pairs:[{postId:'p',reelId:'r',created:true},{created:false},{created:null}]});
 });
});
