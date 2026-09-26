/**
 * The service-role boundary for horse-authored video Reels.
 *
 * A horse video is one user-visible object with two projections:
 * `social_posts` and `social_reels`. The database RPC owns both projections,
 * the asset/phrase ledgers, and their retry identity in one transaction. A
 * direct table insert cannot provide that guarantee because the legacy mirror
 * trigger intentionally treats non-library Reel failures as best effort.
 */
import { getSupabase } from '../supabase.js';
import { assetKeyFor } from './ContentLedger.js';

export type HorseVideoTopic = 'poker' | 'sports';
export type YouTubeVerificationVerdict =
  | 'verified'
  | 'unavailable'
  | 'private'
  | 'restricted'
  | 'embed_disabled'
  | 'error'
  | 'network_error';

interface VerificationRow {
  video_id?: string;
  verification_status?: string;
  resolved?: boolean;
}

interface PublicationRow {
  social_post_id?: string;
  social_reel_id?: string;
  created?: boolean;
}

export interface HorseVideoPublicationInput {
  authorId: string;
  videoUrl: string;
  caption: string;
  topic: HorseVideoTopic;
  assetKey: string;
  phraseNorm: string;
  semanticKey: string;
  metadata: Record<string, unknown>;
}

export interface HorseVideoPublicationResult {
  success: boolean;
  postId?: string;
  reelId?: string;
  created?: boolean;
  outcome?: 'unknown';
  error?: string;
}

function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T | undefined) ?? null;
  if (data && typeof data === 'object') return data as T;
  return null;
}

/**
 * Persist the oEmbed verdict in the shared verification registry.
 *
 * Returning false is deliberate. A local HTTP 200 is not durable proof for
 * the public feed until the shared registry accepts it. Publication RPCs read
 * that registry and therefore cannot be tricked by a process-local cache.
 */
export async function recordYouTubeVerification(
  videoId: string,
  verdict: YouTubeVerificationVerdict,
  verificationStartedAt: string,
): Promise<boolean> {
  const { data, error } = await getSupabase().rpc(
    'record_youtube_embed_failure_verdict',
    {
      p_video_id: videoId,
      p_verdict: verdict,
      p_error_code: verdict === 'verified' ? null : 150,
      p_surface: 'horse_video_reels',
      p_verification_started_at: verificationStartedAt,
    },
  );
  if (error) {
    console.warn('[horse-video-reels] shared YouTube verdict write failed:', error.message);
    return false;
  }

  const row = firstRow<VerificationRow>(data);
  if (!row || row.video_id !== videoId) return false;
  if (verdict === 'verified') {
    return row.verification_status === 'resolved' && row.resolved === true;
  }
  if (verdict === 'error' || verdict === 'network_error') {
    return row.verification_status === 'error' || row.verification_status === 'confirmed';
  }
  return row.verification_status === 'confirmed' && row.resolved === false;
}

/**
 * Publish the post, Reel and dedup ledgers as one database transaction.
 *
 * Timeouts are reported as unknown by the shared Supabase client and are not
 * retried here. A later route invocation presents the same durable asset key;
 * the RPC returns the prior post/Reel pair rather than duplicating it.
 */
export async function publishHorseVideoAtomically(
  input: HorseVideoPublicationInput,
): Promise<HorseVideoPublicationResult> {
  const derivedKey = assetKeyFor(input.videoUrl);
  if (!derivedKey?.startsWith('yt:') || derivedKey !== input.assetKey) {
    return { success: false, error: 'horse video publication requires one canonical YouTube asset key' };
  }
  if (!input.authorId || !input.caption.trim() || !input.phraseNorm || !input.semanticKey.trim()) {
    return { success: false, error: 'horse video publication is missing required author, caption, or semantic data' };
  }

  let response: Awaited<ReturnType<ReturnType<typeof getSupabase>['rpc']>>;
  try {
    response = await getSupabase().rpc('publish_horse_video_reel', {
      p_author_id: input.authorId,
      p_video_url: input.videoUrl,
      p_caption: input.caption,
      p_topic: input.topic,
      p_asset_key: input.assetKey,
      p_phrase_norm: input.phraseNorm,
      p_semantic_key: input.semanticKey,
      p_metadata: input.metadata,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      outcome: 'unknown',
      error: `atomic horse video publication outcome unknown: ${message}`,
    };
  }
  const { data, error } = response;
  if (error) {
    const code = String(error.code ?? '');
    const message = String(error.message ?? 'database request failed');
    if (
      !code
      || /^PGRST00[0-2]$/.test(code)
      || /abort|timeout|timed out|network|fetch|connection|socket|econnreset/i.test(message)
    ) {
      return {
        success: false,
        outcome: 'unknown',
        error: `atomic horse video publication outcome unknown: ${message}`,
      };
    }
    return { success: false, error: `atomic horse video publication failed: ${error.message}` };
  }

  const row = firstRow<PublicationRow>(data);
  if (!row?.social_post_id || !row.social_reel_id) {
    return { success: false, error: 'atomic horse video publication returned no linked post/Reel pair' };
  }
  return {
    success: true,
    postId: row.social_post_id,
    reelId: row.social_reel_id,
    created: row.created === true,
  };
}
