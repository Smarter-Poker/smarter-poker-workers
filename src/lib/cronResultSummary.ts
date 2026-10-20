/**
 * `cron_execution_log.result` had been `{}` on every one of the 4,110 rows
 * this middleware has written.
 *
 * That is why the collusion detector's death took a person reading source to
 * diagnose. The log could say a run SUCCEEDED and how long it took, and
 * nothing else - not how many hands it read, not whether it truncated, not
 * whether the mark moved. A run that reads 200 hands cleanly and a run that
 * stops dead on its row cap 40,000 rows into a six-hour backlog were the same
 * green row. The handlers were already returning all of it in their response
 * bodies and the log was throwing it away.
 *
 * Bounded on purpose: JSON only, 8KB only, and any failure to read it leaves
 * the row exactly as it would have been. Logging must never change what a
 * cron returns.
 */
export const RESULT_MAX_BYTES = 8_000;

// Keep the authoritative publication receipt ahead of bulky diagnostic data.
// This is a projection, never a reconstruction: absent/unknown values remain
// absent/unknown. Full post/Reel IDs allow independent persisted correlation.
function publicationSummary(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.post_ids) || !Array.isArray(body.reel_ids) || !body.delivery) return null;
  if ([body.post_ids, body.reel_ids].some(ids => ids.length > 80 || ids.some(id => typeof id !== 'string' || id.length > 36))) return null;
  const summary: Record<string, unknown> = {summary_compacted: true};
  for (const key of ['success','fleet','due','attempted','posted','created','replayed','failed','unknown','deadline_hit','halted_on_unknown','not_attempted','timestamp','duration_ms','skipped_recent','content_exhausted','caption_exhausted','duplicate_slot']) {
    if (Object.hasOwn(body,key)) summary[key] = body[key];
  }
  summary.post_ids = body.post_ids;
  summary.reel_ids = body.reel_ids;
  if (typeof body.delivery !== 'object' || Array.isArray(body.delivery)) return null;
  summary.delivery = Object.fromEntries(Object.entries(body.delivery as Record<string, unknown>).filter(([key]) => ['acknowledged','created','replayed','creation_unknown','public_persisted','not_public','visibility_unknown','endpoint_verified'].includes(key)));
  // Unknown/failed operation recovery tuples must not silently disappear.
  for (const key of ['publication_failures','errors','error','publication_budget','skipped_by_reason']) {
    if (Object.hasOwn(body,key)) summary[key] = body[key];
  }
  return Buffer.byteLength(JSON.stringify(summary),'utf8') <= RESULT_MAX_BYTES ? summary : null;
}

/** Reading the local scraper's status does not execute its daily job. */
export function isCronExecutionRequest(method: string, pathname: string, videoScope?: unknown): boolean {
  return pathname !== '/cron/video-library-scraper' || (method === 'POST' && videoScope === 'full');
}
export async function readResultSummary(res: Response | undefined): Promise<Record<string, unknown>> {
  try {
    if (!res) return {};
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) return {};
    // clone() so the response the caller receives is untouched.
    const text = await res.clone().text();
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > RESULT_MAX_BYTES) {
      return publicationSummary(JSON.parse(text)) ?? { truncated: true, bytes, head: text.slice(0, 500) };
    }
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return {};
  }
}
