import { getSupabase } from '../supabase.js';

export interface PublicationEvidence {
  status: 'public_persisted' | 'not_public' | 'unknown';
  endpointVerified: false;
  observedAt: string;
  reason?: string;
}

/** News has a public link post, not a post/Reel pair. Never republish after a failed read. */
export async function readHorseNewsPublicationEvidence(input: {
  postId: string; authorId: string; caption: string; linkUrl: string; linkTitle: string;
}): Promise<PublicationEvidence> {
  const base = { endpointVerified: false as const, observedAt: new Date().toISOString() };
  try {
    const posts = await getSupabase().from('social_posts')
      .select('id,author_id,content,visibility,is_deleted,origin_type,content_type,link_url,link_title')
      .eq('id', input.postId).limit(2).abortSignal(AbortSignal.timeout(6_000));
    if (posts.error || !Array.isArray(posts.data) || posts.data.length > 1) {
      return { ...base, status: 'unknown', reason: 'Persisted news readback unavailable or malformed' };
    }
    const post = posts.data[0];
    const publicPost = post?.id === input.postId && post.author_id === input.authorId
      && post.content === input.caption && post.visibility === 'public' && post.is_deleted === false
      && post.origin_type === 'horse' && post.content_type === 'link'
      && post.link_url === input.linkUrl && post.link_title === input.linkTitle;
    return { ...base, status: publicPost ? 'public_persisted' : 'not_public',
      ...(publicPost ? {} : { reason: 'Acknowledged news does not match public persisted link post contract' }) };
  } catch (error) {
    return { ...base, status: 'unknown', reason: `Persisted news readback failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Read only. An acknowledged transaction is never retried because its readback failed. */
export async function readHorseVideoPublicationEvidence(input: {
  postId: string; reelId: string; authorId: string; caption: string; assetKey: string;
}): Promise<PublicationEvidence> {
  const base = { endpointVerified: false as const, observedAt: new Date().toISOString() };
  try {
    const [posts, reels] = await Promise.all([
      getSupabase().from('social_posts').select('id,author_id,content,visibility,is_deleted,origin_type')
        .eq('id', input.postId).limit(2).abortSignal(AbortSignal.timeout(6_000)),
      getSupabase().from('social_reels').select('id,source_post_id,author_id,caption,origin_type,is_public,canonical_asset_key,media_status,rights_status')
        .eq('id', input.reelId).limit(2).abortSignal(AbortSignal.timeout(6_000)),
    ]);
    if (posts.error || reels.error || !Array.isArray(posts.data) || !Array.isArray(reels.data)
      || posts.data.length > 1 || reels.data.length > 1) {
      return {...base,status:'unknown',reason:'Persisted publication readback unavailable or malformed'};
    }
    const post = posts.data[0], reel = reels.data[0];
    const publicPair = post?.id === input.postId && post.author_id === input.authorId
      && post.content === input.caption && post.visibility === 'public' && post.is_deleted !== true && post.origin_type === 'horse'
      && reel?.id === input.reelId && reel.source_post_id === input.postId && reel.author_id === input.authorId
      && reel.caption === input.caption && reel.origin_type === 'horse' && reel.is_public === true
      && reel.canonical_asset_key === input.assetKey.replace(/^yt:/, 'youtube:') && reel.media_status === 'ready'
      && reel.rights_status === 'embed_only';
    return {...base,status:publicPair?'public_persisted':'not_public',
      ...(publicPair ? {} : {reason:'Acknowledged pair does not match public persisted post/Reel contract'})};
  } catch (error) {
    return {...base,status:'unknown',reason:`Persisted publication readback failed: ${error instanceof Error?error.message:String(error)}`};
  }
}

export function publicationDeliverySummary(results: readonly {
  success: boolean; postId?: string; reelId?: string; created?: boolean; publicationEvidence?: PublicationEvidence;
}[]) {
  const committed = results.filter(result=>result.success);
  return {
    acknowledged: committed.length,
    created: committed.filter(result=>result.created === true).length,
    replayed: committed.filter(result=>result.created === false).length,
    creation_unknown: committed.filter(result=>result.created === undefined).length,
    public_persisted: committed.filter(result=>result.publicationEvidence?.status === 'public_persisted').length,
    not_public: committed.filter(result=>result.publicationEvidence?.status === 'not_public').length,
    visibility_unknown: committed.filter(result=>!result.publicationEvidence || result.publicationEvidence.status === 'unknown').length,
    endpoint_verified: 0,
    pairs: committed.map(result=>({postId:result.postId ?? null,reelId:result.reelId ?? null,
      created:result.created ?? null,evidence:result.publicationEvidence ?? {status:'unknown',endpointVerified:false,reason:'No persisted pair readback on this content path'}})),
  };
}
