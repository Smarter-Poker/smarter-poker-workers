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
export async function readResultSummary(res: Response | undefined): Promise<Record<string, unknown>> {
  try {
    if (!res) return {};
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) return {};
    // clone() so the response the caller receives is untouched.
    const text = await res.clone().text();
    if (text.length > RESULT_MAX_BYTES) {
      return { truncated: true, bytes: text.length, head: text.slice(0, 500) };
    }
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return {};
  }
}
