import { getSupabase } from '../supabase.js';
import type { PublicationEvidence } from './PublicationEvidence.js';

interface GroundedBrief {
  kind:string; domain:string; title?:string; sport?:string; source?:string; topic?:string;
  people:string[]; teams:string[]; concepts:string[]; amounts:string[];
  tone:string; isQuestion:boolean; confidence:number; builtFrom:string[];
}
export interface HorseGroundedPublicationInput {
  authorId:string; reviewId:string; content:string; phraseNorm:string; semanticKey:string;
  frameKey:string; publicationKey:string; brief:GroundedBrief;
}
export interface HorseGroundedPublicationResult {
  success:boolean; postId?:string; created?:boolean; reason?:string; error?:string;
  code?:string; outcome?:'unknown';
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noWriteReasons = new Set(['duplicate_slot','posted_recently','phrase_used','frame_used','source_used']);

/** One transaction only. A lost acknowledgment retains an unknown outcome. */
export async function publishHorseGroundedAtomically(input:HorseGroundedPublicationInput):Promise<HorseGroundedPublicationResult> {
  if (!uuid.test(input.authorId) || !/^[1-9][0-9]*$/.test(input.reviewId)
    || !input.content.trim() || !input.phraseNorm.trim() || !input.frameKey.trim()
    || !input.semanticKey.startsWith('grounded:hand:') || !uuid.test(input.semanticKey.slice(14))
    || !input.publicationKey.startsWith(`fleet:${input.authorId}:`)
    || !input.brief || input.brief.kind !== 'hand' || input.brief.domain !== 'poker') {
    return {success:false,error:'Grounded hand publication requires an owned review, hand identity, caption, frame and brief'};
  }
  let response;
  try {
    response = await getSupabase().rpc('publish_horse_grounded_hand', {
      p_author_id:input.authorId,p_review_id:input.reviewId,p_content:input.content,
      p_phrase_norm:input.phraseNorm,p_semantic_key:input.semanticKey,p_frame_key:input.frameKey,
      p_publication_key:input.publicationKey,p_brief:input.brief,
    });
  } catch(error) {
    return {success:false,outcome:'unknown',error:`Atomic grounded hand publication outcome unknown: ${error instanceof Error?error.message:String(error)}`};
  }
  if(response.error){
    const code=String(response.error.code??''),message=String(response.error.message??'Database request failed');
    const definiteRollback=['57014','55P03','40P01'].includes(code);
    const unknown=!definiteRollback&&(!code||/^PGRST00[0-2]$/.test(code)||/^08/.test(code)||/abort|timeout|timed out|network|fetch|connection|socket|econnreset/i.test(message));
    return {success:false,code,...(unknown?{outcome:'unknown' as const}:{}),error:message};
  }
  const rows=response.data;
  const row=Array.isArray(rows)&&rows.length===1?rows[0]:null;
  if(row&&row.created===false&&row.social_post_id===null&&noWriteReasons.has(row.reason))return {success:false,reason:row.reason};
  if(!row||typeof row.social_post_id!=='string'||!uuid.test(row.social_post_id)
    ||typeof row.created!=='boolean'||row.reason!==(row.created?'published':'already_published')){
    return {success:false,outcome:'unknown',error:'Atomic grounded hand publication returned a malformed receipt'};
  }
  return {success:true,postId:row.social_post_id,created:row.created,reason:row.reason};
}

/** Acknowledged writes are read, never retried because verification failed. */
export async function readHorseGroundedPublicationEvidence(input:HorseGroundedPublicationInput&{postId:string}):Promise<PublicationEvidence>{
  const base={endpointVerified:false as const,observedAt:new Date().toISOString()};
  try{
    const supa=getSupabase();
    const responses=await Promise.all([
      supa.from('social_posts').select('id,author_id,content,content_type,origin_type,visibility,audience_mode,is_deleted,metadata').eq('id',input.postId).limit(2).abortSignal(AbortSignal.timeout(6000)),
      supa.from('horse_phrase_ledger').select('phrase_norm,horse_id,post_id').eq('post_id',input.postId).limit(4).abortSignal(AbortSignal.timeout(6000)),
      supa.from('post_briefs').select('post_id,kind,domain,title,sport,source,topic,people,teams,concepts,amounts,tone,is_question,confidence,built_from').eq('post_id',input.postId).limit(2).abortSignal(AbortSignal.timeout(6000)),
    ]);
    if(responses.some(r=>r.error||r.status>=400||!Array.isArray(r.data)))return {...base,status:'unknown',reason:'Grounded publication readback unavailable or malformed'};
    const posts=responses[0].data,ledger=responses[1].data,briefs=responses[2].data;
    if(!posts||!ledger||!briefs||posts.length>1||briefs.length>1||ledger.length>3)return {...base,status:'unknown',reason:'Grounded publication readback has ambiguous records'};
    const post=posts[0],brief=briefs[0],meta=post?.metadata;
    const exact=post?.id===input.postId&&post.author_id===input.authorId&&post.content===input.content
      &&post.content_type==='text'&&post.origin_type==='horse'&&post.visibility==='public'&&post.audience_mode==='public'
      &&(post.is_deleted===false||post.is_deleted===null)
      &&meta?.grounded===true&&meta.grounded_type==='hand'&&meta.hand_review_id===input.reviewId
      &&meta.hand_id===input.semanticKey.slice(14)&&meta.phrase_norm===input.phraseNorm
      &&meta.semantic_key===input.semanticKey&&meta.frame_key===input.frameKey
      &&meta.publication_key===input.publicationKey&&meta.publication_contract==='horse_grounded_hand_v1'
      &&ledger.length===3&&[input.phraseNorm,input.semanticKey,input.frameKey].every(key=>ledger.filter(r=>r.phrase_norm===key&&r.horse_id===input.authorId&&r.post_id===input.postId).length===1)
      &&brief?.post_id===input.postId&&brief.kind===input.brief.kind&&brief.domain===input.brief.domain
      &&brief.tone===input.brief.tone&&brief.is_question===input.brief.isQuestion&&Number(brief.confidence)===input.brief.confidence
      &&(['people','teams','concepts','amounts'] as const).every(key=>JSON.stringify(brief[key])===JSON.stringify(input.brief[key]))
      &&JSON.stringify(brief.built_from)===JSON.stringify([...new Set(input.brief.builtFrom)])
      &&(['title','sport','source','topic'] as const).every(key=>(brief[key]??null)===(input.brief[key]||null));
    return {...base,status:exact?'public_persisted':'not_public',...(exact?{}:{reason:'Grounded post or atomic audit records do not match the acknowledged operation'})};
  }catch(error){return {...base,status:'unknown',reason:`Grounded publication readback failed: ${error instanceof Error?error.message:String(error)}`};}
}
