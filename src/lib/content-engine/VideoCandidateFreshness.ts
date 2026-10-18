import { getSupabase } from '../supabase.js';
import { composeCaption, RELEVANCE_FLOOR } from './Composer.js';
import { briefForAsset } from './PostBrief.js';
import { styleSheetFor } from './StyleSheet.js';
import { PHRASE_GLOBAL_HOURS, PHRASE_HORSE_DAYS } from './ContentLedger.js';
import { PLATFORM_CANDIDATE_LIMIT, type SupplyClip } from './ClipSupply.js';

// A real factual catalogue must not disappear merely because it contains
// more than 120 different thoughts. Bound by the existing 1,000 clips and
// six writer drafts instead; SELECT chunks and concurrency remain small.
export const VIDEO_FRESHNESS_KEY_LIMIT = PLATFORM_CANDIDATE_LIMIT * 6;
export const VIDEO_FRESHNESS_KEY_CHUNK = 20;
const LEDGER_ROW_LIMIT = 1_000;
// Matches the canonical Supabase client's maintained twenty-second ceiling.
const LEDGER_TIMEOUT_MS = 20_000;
const DRAFTS = 6;

/** Only an idempotent SELECT may repeat, and only after a transient failure. */
function transientLedgerReadFailure(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 2) return false;
  const failure = value as {status?: unknown; code?: unknown; error?: unknown; cause?: unknown};
  if ([502, 503, 504].includes(Number(failure.status))) return true;
  if (typeof failure.code === 'string'
    && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(failure.code)) return true;
  return transientLedgerReadFailure(failure.error, depth + 1) || transientLedgerReadFailure(failure.cause, depth + 1);
}

/** The exact deterministic meanings the ordinary six-draft writer can use. */
export function videoCandidateMeanings(clip: SupplyClip, topic: 'poker' | 'sports', profileId: string): string[] {
  const brief = briefForAsset({ kind: 'video', title: clip.title, source: clip.source, domainHint: topic, sportHint: clip.sport_type ?? clip.category });
  const style = styleSheetFor(profileId);
  return [...new Set(Array.from({ length: DRAFTS }, (_, index) => composeCaption(brief, style, String(index)))
    .filter(draft => draft.text && draft.relevance >= RELEVANCE_FLOOR && draft.semanticKey)
    .map(draft => draft.semanticKey!))];
}

export type VideoFreshnessResult =
  | { status: 'ok'; clips: SupplyClip[]; scanned: number; stale: number; keys: number; ungroundable: number; reused: number }
  | { status: 'unknown'; error: string };

/** Remove stale thoughts BEFORE the six-candidate cap, never weakening reuse. */
export async function freshVideoCaptionCandidates(
  clips: readonly SupplyClip[], topic: 'poker' | 'sports', profileId: string,
): Promise<VideoFreshnessResult> {
  if (clips.length > PLATFORM_CANDIDATE_LIMIT) return { status: 'unknown', error: 'Video freshness snapshot exceeds bounded platform supply' };
  const candidates = clips.map(clip => ({ clip, meanings: videoCandidateMeanings(clip, topic, profileId) }));
  const ungroundable = candidates.filter(candidate=>candidate.meanings.length===0).length;
  const keys = [...new Set(candidates.flatMap(candidate => candidate.meanings))];
  if (keys.length > VIDEO_FRESHNESS_KEY_LIMIT) return { status: 'unknown', error: 'Video freshness meaning set exceeds bounded ledger scan' };
  if (!keys.length) return { status: 'ok', clips: [], scanned: clips.length, stale: clips.length, keys: 0, ungroundable, reused:0 };
  const used = new Set<string>();
  const globalSince = new Date(Date.now() - PHRASE_GLOBAL_HOURS * 3_600_000).toISOString();
  const horseSince = new Date(Date.now() - PHRASE_HORSE_DAYS * 86_400_000).toISOString();
  try {
    const queries: Array<() => Promise<void>> = [];
    for (let index = 0; index < keys.length; index += VIDEO_FRESHNESS_KEY_CHUNK) {
      const chunk = keys.slice(index, index + VIDEO_FRESHNESS_KEY_CHUNK);
      for (const [table, column] of [['horse_phrase_ledger', 'phrase_norm'], ['horse_semantic_ledger', 'semantic_key']] as const) {
        for (const mine of [false, true]) {
          queries.push(async () => {
            // Two total attempts, no delay or background repair. Construct a
            // new SELECT each time; never repeat a mutation or RPC. A second
            // failure remains unknown, just as before this bounded recovery.
            for (let attempt = 0; attempt < 2; attempt++) {
              let query = getSupabase().from(table).select(column).in(column, chunk)
                .gte('used_at', mine ? horseSince : globalSince).limit(LEDGER_ROW_LIMIT);
              if (mine) query = query.eq('horse_id', profileId);
              let result;
              try {
                result = await query.abortSignal(AbortSignal.timeout(LEDGER_TIMEOUT_MS));
              } catch (error) {
                if (attempt === 0 && transientLedgerReadFailure(error)) continue;
                throw error;
              }
              if (result.error || result.status >= 400) {
                if (attempt === 0 && transientLedgerReadFailure(result)) continue;
                throw new Error(result.error?.message ?? `Video freshness ledger HTTP ${result.status}`);
              }
              // PostgREST may truncate a full page. Absence cannot prove unused.
              if (!Array.isArray(result.data) || result.data.length >= LEDGER_ROW_LIMIT) {
                throw new Error('Incomplete video freshness ledger response');
              }
              for (const row of result.data) {
                const value = (row as unknown as Record<string, unknown>)[column];
                if (typeof value !== 'string' || !chunk.includes(value)) throw new Error('Malformed video freshness ledger key');
                used.add(value);
              }
              return;
            }
          });
        }
      }
    }
    let next = 0;
    let failed = false;
    await Promise.all(Array.from({length:Math.min(4,queries.length)},async()=>{
      while(!failed&&next<queries.length){
        try {await queries[next++]!();}
        catch(error){failed=true;throw error;}
      }
    }));
    const fresh = candidates.filter(candidate => candidate.meanings.some(key => !used.has(key))).map(candidate => candidate.clip);
    return { status: 'ok', clips: fresh, scanned: clips.length, stale: clips.length - fresh.length, keys: keys.length,
      ungroundable,reused:clips.length-fresh.length-ungroundable };
  } catch (error) {
    return { status: 'unknown', error: `Video freshness ledger unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
