import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ rpc: vi.fn(), rows: {} as Record<string, unknown[]>, error: false }));
vi.mock('../supabase.js', () => ({ getSupabase: () => ({ rpc: db.rpc, from: (table: string) => {
  const q = { select: () => q, eq: () => q, limit: () => q, abortSignal: async () => ({
    data: db.rows[table], error: db.error ? {message:'offline'} : null, status: db.error ? 503 : 200,
  }) }; return q;
} }) }));
import { publishHorseGroundedAtomically, readHorseGroundedPublicationEvidence } from './HorseGroundedPublication.js';
const input = { authorId:'11111111-1111-4111-8111-111111111111', reviewId:'123', content:'I folded on the river.',
  phraseNorm:'i folded on the river', semanticKey:'grounded:hand:22222222-2222-4222-8222-222222222222',
  frameKey:'frame:voice:big_fold:0', publicationKey:'fleet:11111111-1111-4111-8111-111111111111:2026-10-19T12',
  brief:{kind:'hand',domain:'poker',title:'a hand from the tables',source:'club arena',people:[],teams:[],concepts:['big_fold'],amounts:[],tone:'analytical',isQuestion:false,confidence:1,builtFrom:['horse_hand_reviews']} };
const postId='33333333-3333-4333-8333-333333333333';
beforeEach(() => {
  db.rpc.mockReset(); db.error=false;
  db.rpc.mockResolvedValue({data:[{social_post_id:postId,created:true,reason:'published'}],error:null});
  db.rows={social_posts:[{id:postId,author_id:input.authorId,content:input.content,content_type:'text',origin_type:'horse',visibility:'public',audience_mode:'public',is_deleted:false,
    metadata:{grounded:true,grounded_type:'hand',hand_review_id:'123',hand_id:'22222222-2222-4222-8222-222222222222',phrase_norm:input.phraseNorm,semantic_key:input.semanticKey,frame_key:input.frameKey,publication_key:input.publicationKey,publication_contract:'horse_grounded_hand_v1'}}],
    horse_phrase_ledger:[input.phraseNorm,input.semanticKey,input.frameKey].map(phrase_norm=>({phrase_norm,horse_id:input.authorId,post_id:postId})),
    post_briefs:[{post_id:postId,kind:'hand',domain:'poker',title:'a hand from the tables',source:'club arena',people:[],teams:[],concepts:['big_fold'],amounts:[],tone:'analytical',is_question:false,confidence:1,built_from:['horse_hand_reviews']}]};
});
describe('atomic own-hand publication boundary',()=>{
  it('submits one transaction and returns a controlled creation receipt',async()=>{
    expect(await publishHorseGroundedAtomically(input)).toMatchObject({success:true,postId,created:true});
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith('publish_horse_grounded_hand',{p_author_id:input.authorId,p_review_id:'123',p_content:input.content,p_phrase_norm:input.phraseNorm,p_semantic_key:input.semanticKey,p_frame_key:input.frameKey,p_publication_key:input.publicationKey,p_brief:input.brief});
  });
  it('keeps an exact replay out of fresh creation accounting',async()=>{
    db.rpc.mockResolvedValue({data:[{social_post_id:postId,created:false,reason:'already_published'}],error:null});
    expect(await publishHorseGroundedAtomically(input)).toMatchObject({success:true,postId,created:false});
  });
  it.each(['duplicate_slot','posted_recently','phrase_used','frame_used','source_used'])('returns definite no-write %s',async reason=>{
    db.rpc.mockResolvedValue({data:[{social_post_id:null,created:false,reason}],error:null});
    expect(await publishHorseGroundedAtomically(input)).toMatchObject({success:false,reason});
  });
  it.each(['57014','55P03','40P01'])('retains definite database rollback %s',async code=>{
    db.rpc.mockResolvedValue({data:null,error:{code,message:'statement timeout'}});
    expect(await publishHorseGroundedAtomically(input)).toMatchObject({success:false,code});
    expect((await publishHorseGroundedAtomically(input)).outcome).not.toBe('unknown');
  });
  it('does not retry a transport timeout',async()=>{
    db.rpc.mockRejectedValue(new Error('socket timeout'));
    expect(await publishHorseGroundedAtomically(input)).toMatchObject({success:false,outcome:'unknown'});
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });
  it.each([[],[{social_post_id:postId,created:'yes',reason:'published'}],[{social_post_id:postId,created:true,reason:'already_published'}]])('fails closed on malformed RPC payload %#',async data=>{
    db.rpc.mockResolvedValue({data,error:null});
    expect(await publishHorseGroundedAtomically(input)).toMatchObject({success:false,outcome:'unknown'});
  });
  it('refuses a missing review identity before any transaction',async()=>{
    expect(await publishHorseGroundedAtomically({...input,reviewId:''})).toMatchObject({success:false});
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it('verifies the public hand post and all atomic audit records',async()=>{
    expect(await readHorseGroundedPublicationEvidence({...input,postId})).toMatchObject({status:'public_persisted',endpointVerified:false});
  });
  it.each(['social_posts','horse_phrase_ledger','post_briefs'])('refuses missing %s evidence',async table=>{
    db.rows[table]=[];
    expect(await readHorseGroundedPublicationEvidence({...input,postId})).not.toMatchObject({status:'public_persisted'});
  });
  it('does not accept another hand identity',async()=>{
    const post=db.rows.social_posts![0] as {metadata:Record<string,unknown>}; post.metadata.hand_id='other';
    expect(await readHorseGroundedPublicationEvidence({...input,postId})).toMatchObject({status:'not_public'});
  });
  it.each(['author_id','content','origin_type','content_type','visibility','audience_mode'])('rejects conflicting post %s',async field=>{
    (db.rows.social_posts![0] as Record<string,unknown>)[field]='wrong';
    expect(await readHorseGroundedPublicationEvidence({...input,postId})).toMatchObject({status:'not_public'});
  });
  it.each(['hand_review_id','phrase_norm','semantic_key','frame_key','publication_key','publication_contract','grounded_type'])('rejects conflicting metadata %s',async field=>{
    (db.rows.social_posts![0] as {metadata:Record<string,unknown>}).metadata[field]='wrong';
    expect(await readHorseGroundedPublicationEvidence({...input,postId})).toMatchObject({status:'not_public'});
  });
  it('rejects a ledger row belonging to another author',async()=>{
    (db.rows.horse_phrase_ledger![0] as Record<string,unknown>).horse_id='other';
    expect(await readHorseGroundedPublicationEvidence({...input,postId})).toMatchObject({status:'not_public'});
  });
  it('rejects a brief that changes the grounded facts',async()=>{
    (db.rows.post_briefs![0] as Record<string,unknown>).amounts=['1000bb'];
    expect(await readHorseGroundedPublicationEvidence({...input,postId})).toMatchObject({status:'not_public'});
  });
  it('keeps malformed non-array evidence unknown',async()=>{
    db.rows.horse_phrase_ledger=null as unknown as unknown[];
    expect(await readHorseGroundedPublicationEvidence({...input,postId})).toMatchObject({status:'unknown'});
  });
  it('keeps unreadable evidence unknown',async()=>{
    db.error=true;
    expect(await readHorseGroundedPublicationEvidence({...input,postId})).toMatchObject({status:'unknown'});
  });
});
