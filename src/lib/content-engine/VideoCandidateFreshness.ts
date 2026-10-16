import { getSupabase } from '../supabase.js';
import { composeCaption, RELEVANCE_FLOOR } from './Composer.js';
import { briefForAsset } from './PostBrief.js';
import { styleSheetFor } from './StyleSheet.js';
import { PHRASE_GLOBAL_HOURS, PHRASE_HORSE_DAYS } from './ContentLedger.js';
import { PLATFORM_CANDIDATE_LIMIT, type SupplyClip } from './ClipSupply.js';

export const VIDEO_FRESHNESS_KEY_LIMIT = 120;
export const VIDEO_FRESHNESS_KEY_CHUNK = 20;
const LEDGER_ROW_LIMIT = 1_000;
// Matches the canonical Supabase client's maintained twenty-second ceiling.
const LEDGER_TIMEOUT_MS = 20_000;
const DRAFTS = 6;

/** The exact deterministic meanings the ordinary six-draft writer can use. */
export function videoCandidateMeanings(clip: SupplyClip, topic: 'poker' | 'sports', profileId: string): string[] {
  const brief = briefForAsset({ kind: 'video', title: clip.title, source: clip.source, domainHint: topic, sportHint: clip.category });
  const style = styleSheetFor(profileId);
  return [...new Set(Array.from({ length: DRAFTS }, (_, index) => composeCaption(brief, style, String(index)))
    .filter(draft => draft.text && draft.relevance >= RELEVANCE_FLOOR && draft.semanticKey)
    .map(draft => draft.semanticKey!))];
}

export type VideoFreshnessResult =
  | { status: 'ok'; clips: SupplyClip[]; scanned: number; stale: number; keys: number }
  | { status: 'unknown'; error: string };

/** Remove stale thoughts BEFORE the six-candidate cap, never weakening reuse. */
export async function freshVideoCaptionCandidates(
  clips: readonly SupplyClip[], topic: 'poker' | 'sports', profileId: string,
): Promise<VideoFreshnessResult> {
  if (clips.length > PLATFORM_CANDIDATE_LIMIT) return { status: 'unknown', error: 'Video freshness snapshot exceeds bounded platform supply' };
  const candidates = clips.map(clip => ({ clip, meanings: videoCandidateMeanings(clip, topic, profileId) }));
  const keys = [...new Set(candidates.flatMap(candidate => candidate.meanings))];
  if (keys.length > VIDEO_FRESHNESS_KEY_LIMIT) return { status: 'unknown', error: 'Video freshness meaning set exceeds bounded ledger scan' };
  if (!keys.length) return { status: 'ok', clips: [], scanned: clips.length, stale: clips.length, keys: 0 };
  const used = new Set<string>();
  const globalSince = new Date(Date.now() - PHRASE_GLOBAL_HOURS * 3_600_000).toISOString();
  const horseSince = new Date(Date.now() - PHRASE_HORSE_DAYS * 86_400_000).toISOString();
  try {
    const queries: Array<Promise<void>> = [];
    for (let index = 0; index < keys.length; index += VIDEO_FRESHNESS_KEY_CHUNK) {
      const chunk = keys.slice(index, index + VIDEO_FRESHNESS_KEY_CHUNK);
      for (const [table, column] of [['horse_phrase_ledger', 'phrase_norm'], ['horse_semantic_ledger', 'semantic_key']] as const) {
        for (const mine of [false, true]) {
          queries.push((async () => {
            let query = getSupabase().from(table).select(column).in(column, chunk)
              .gte('used_at', mine ? horseSince : globalSince).limit(LEDGER_ROW_LIMIT);
            if (mine) query = query.eq('horse_id', profileId);
            const result = await query.abortSignal(AbortSignal.timeout(LEDGER_TIMEOUT_MS));
            // PostgREST may truncate a full page. Absence cannot prove unused.
            if (result.error || !Array.isArray(result.data) || result.data.length >= LEDGER_ROW_LIMIT) {
              throw new Error(result.error?.message ?? 'Incomplete video freshness ledger response');
            }
            for (const row of result.data) {
              const value = (row as unknown as Record<string, unknown>)[column];
              if (typeof value !== 'string' || !chunk.includes(value)) throw new Error('Malformed video freshness ledger key');
              used.add(value);
            }
          })());
        }
      }
    }
    await Promise.all(queries);
    const fresh = candidates.filter(candidate => candidate.meanings.some(key => !used.has(key))).map(candidate => candidate.clip);
    return { status: 'ok', clips: fresh, scanned: clips.length, stale: clips.length - fresh.length, keys: keys.length };
  } catch (error) {
    return { status: 'unknown', error: `Video freshness ledger unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
