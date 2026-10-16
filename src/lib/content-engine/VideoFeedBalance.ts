import { getSupabase } from '../supabase.js';
import { briefForAsset } from './PostBrief.js';
import { clipFormatPriority, type SupplyClip } from './ClipSupply.js';
import { captionFact } from './CaptionVoice.js';
import { composeCaption } from './Composer.js';
import { styleSheetFor } from './StyleSheet.js';
import { captionConvergencePenalty } from './CaptionQuality.js';

export interface RecentVideoContext { title: string; source: string; topic: string; caption?: string }
export type RecentVideoRead = { status: 'ok'; items: RecentVideoContext[] } | { status: 'unknown'; error: string; items: [] };
export const RECENT_VIDEO_CONTEXT_LIMIT = 12;

/** One read per original business run. Missing preference data never defeats safety gates. */
export async function readRecentVideoContext(): Promise<RecentVideoRead> {
  try {
    const { data, error } = await getSupabase().from('social_posts')
      .select('content,link_title,metadata').eq('origin_type', 'horse').eq('visibility', 'public')
      .eq('is_deleted', false).eq('content_type', 'video')
      .order('created_at', { ascending: false }).limit(RECENT_VIDEO_CONTEXT_LIMIT)
      .abortSignal(AbortSignal.timeout(6_000));
    if (error || !Array.isArray(data)) throw new Error(error?.message ?? 'Malformed recent video context');
    return { status: 'ok', items: data.map(row => ({
      title: typeof row.link_title === 'string' ? row.link_title : String(row.content ?? ''),
      caption: String(row.content ?? ''),
      source: typeof row.metadata?.clip_source === 'string' ? row.metadata.clip_source : '',
      topic: typeof row.metadata?.clip_type === 'string' ? row.metadata.clip_type : '',
    })) };
  } catch (error) {
    return { status: 'unknown', items: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function contextFor(title: string, source: string, topic: string) {
  const brief = briefForAsset({kind:'video',title,source,domainHint:topic === 'sports' ? 'sports' : 'poker'});
  // Broad stakes/prize coverage is deliberately one family: changing the
  // dollar amount must not make consecutive guarantees look like variety.
  const money = /\b(?:guarantee|guaranteed|prize|prizepool|buy.in|bounty|million|gtd)\b/i.test(title);
  return { concepts: new Set(brief.concepts), people: new Set(brief.people.map(value=>value.toLowerCase())), money };
}

/** Soft concentration penalty only; never fabricates facts or embargoes valid supply. */
export function videoFeedConcentration(clip: SupplyClip, topic: 'poker' | 'sports', recent: readonly RecentVideoContext[]): number {
  const own = contextFor(clip.title, clip.source, topic);
  let score = 0;
  recent.slice(0, RECENT_VIDEO_CONTEXT_LIMIT).forEach((item, index) => {
    const prior = contextFor(item.title || item.caption || '', item.source, item.topic);
    const weight = index < 2 ? 3 : 1;
    if (own.money && prior.money) score += 5 * weight;
    if ([...own.people].some(person=>prior.people.has(person))) score += 4 * weight;
    if ([...own.concepts].some(concept=>prior.concepts.has(concept))) score += 2 * weight;
    if (clip.source && clip.source.toLowerCase() === item.source.toLowerCase()) score += weight;
    if (topic === 'sports' && item.topic === 'sports') score += weight;
  });
  return Math.min(299, score);
}

/** Format tier stays authoritative; diverse grounded choices beat repeated facts within it. */
export function balancedVideoPriority(clip: SupplyClip, topic: 'poker' | 'sports', recent: readonly RecentVideoContext[], preferredSource: boolean, profileId?: string): number {
  const brief = briefForAsset({kind:'video', title:clip.title, source:clip.source, domainHint:topic, sportHint:clip.category});
  const draft = profileId ? composeCaption(brief, styleSheetFor(profileId), '0').text : '';
  const fact = captionFact(brief);
  const shapePenalty = draft ? captionConvergencePenalty(draft, recent.map(item=>item.caption ?? ''), {subject:fact?.subject}) : 0;
  return clipFormatPriority(clip) * 1_000
    + videoFeedConcentration(clip, topic, recent) * 2
    + (fact ? 0 : 100)
    + Math.round(shapePenalty*60)
    + (preferredSource ? 0 : 1);
}

/** Poker remains the default; a concentrated poker subject may yield to an approved diverse short. */
export function balancedVideoTypes(kinds: readonly ('poker'|'sports')[], supply: {poker:SupplyClip[];sports:SupplyClip[]}, recent: readonly RecentVideoContext[]) {
  const score=(kind:'poker'|'sports')=>Math.min(...supply[kind].map(clip=>videoFeedConcentration(clip,kind,recent)))
    + (kind==='sports'?8:0);
  return kinds.filter(kind=>supply[kind].length>0).sort((a,b)=>score(a)-score(b));
}
