import { getSupabase } from '../supabase.js';
import type { PostBrief } from './PostBrief.js';

export interface HorseNewsPublicationInput {
  authorId: string;
  content: string;
  linkUrl: string;
  linkTitle: string;
  linkDescription?: string | null;
  linkImage?: string | null;
  linkSiteName: string;
  newsType: 'poker' | 'sports';
  publicationKey: string;
  assetKey: string;
  phraseNorm: string;
  semanticKey: string;
  brief: PostBrief;
}

export interface HorseNewsPublicationResult {
  success: boolean;
  postId?: string;
  created?: boolean;
  reason?: 'already_published' | 'duplicate_slot' | 'posted_recently' | 'asset_used' | 'phrase_used';
  outcome?: 'unknown';
  error?: string;
}

interface PublicationRow {
  social_post_id?: string | null;
  created?: boolean | null;
  reason?: string | null;
}

function firstRow(data: unknown): PublicationRow | null {
  if (Array.isArray(data)) return (data[0] as PublicationRow | undefined) ?? null;
  return data && typeof data === 'object' ? data as PublicationRow : null;
}

/** Publish the link post and every freshness ledger row in one transaction. */
export async function publishHorseNewsAtomically(
  input: HorseNewsPublicationInput,
): Promise<HorseNewsPublicationResult> {
  if (
    !input.authorId || !input.content.trim() || !input.linkUrl || !input.linkTitle.trim()
    || !input.linkSiteName.trim() || !input.publicationKey || !input.assetKey
    || !input.phraseNorm || !input.semanticKey
  ) {
    return { success: false, error: 'horse news publication is missing required source or freshness data' };
  }

  let response: Awaited<ReturnType<ReturnType<typeof getSupabase>['rpc']>>;
  try {
    response = await getSupabase().rpc('publish_horse_news_post', {
      p_author_id: input.authorId,
      p_content: input.content,
      p_link_url: input.linkUrl,
      p_link_title: input.linkTitle,
      p_link_description: input.linkDescription ?? null,
      p_link_image: input.linkImage ?? null,
      p_link_site_name: input.linkSiteName,
      p_news_type: input.newsType,
      p_publication_key: input.publicationKey,
      p_asset_key: input.assetKey,
      p_phrase_norm: input.phraseNorm,
      p_semantic_key: input.semanticKey,
      p_brief: input.brief,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, outcome: 'unknown', error: `atomic horse news publication outcome unknown: ${message}` };
  }

  const { data, error } = response;
  if (error) {
    const code = String(error.code ?? '');
    const message = String(error.message ?? 'database request failed');
    if (!code || /^PGRST00[0-2]$/.test(code) || /abort|timeout|timed out|network|fetch|connection|socket|econnreset/i.test(message)) {
      return { success: false, outcome: 'unknown', error: `atomic horse news publication outcome unknown: ${message}` };
    }
    return { success: false, error: `atomic horse news publication failed: ${message}` };
  }

  const row = firstRow(data);
  const reason = row?.reason;
  if (
    row?.created === false
    && (
      reason === 'already_published' || reason === 'duplicate_slot' || reason === 'posted_recently'
      || reason === 'asset_used' || reason === 'phrase_used'
    )
  ) {
    return { success: false, created: false, reason, postId: row.social_post_id ?? undefined };
  }
  if (!row?.social_post_id || row.created !== true) {
    return { success: false, error: 'atomic horse news publication returned no created post' };
  }
  return { success: true, created: true, postId: row.social_post_id };
}
