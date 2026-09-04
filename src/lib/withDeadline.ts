/**
 * Put a ceiling on an awaited call, whatever the library underneath does.
 *
 * WHY THIS AND NOT JUST A FETCH TIMEOUT (2026-09-04)
 * -------------------------------------------------
 * The collusion scan gave its READ a wall-clock budget and gave nothing else
 * one - not the horse lookup, not the findings insert, not the RPC that moves
 * the mark. A run then sat at `running` in cron_execution_log for ten minutes
 * with no error, no log line and nothing naming which call it was on, until
 * the stale sweeper marked it `killed`. Not slow. Never finished. Nothing said
 * so. That is the outage this scan was rewritten to fix, one layer down.
 *
 * The obvious repair is a timeout on the client's fetch, and that IS in place
 * (see supabase.ts). It is not sufficient, and this was measured rather than
 * assumed: with a fetch that only settles on abort, the abort fires, the fetch
 * rejects - and the supabase-js call still never settles. It even re-issues
 * the request. So a caller awaiting `.select()` can hang with a perfectly good
 * fetch timeout underneath it.
 *
 * Therefore the deadline lives where the await is. `Promise.race` does not
 * care what the library does with the rejection: after `ms`, the caller gets
 * an error naming the call and the elapsed time, and the handler carries on to
 * report a failed run instead of vanishing.
 *
 * IT DOES NOT CANCEL AND IT NEVER RETRIES. The underlying request may already
 * have executed on the server - replaying a write is a money-integrity hazard
 * (Club Arena CLAUDE.md section 2). This turns an invisible hang into a loud
 * failure; it is not a recovery, and it must never be read as one.
 */
export class DeadlineExceededError extends Error {
  constructor(
    readonly label: string,
    readonly ms: number,
  ) {
    super(`${label} did not answer within ${ms}ms`);
    this.name = 'DeadlineExceededError';
  }
}

export async function withDeadline<T>(
  work: PromiseLike<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DeadlineExceededError(label, ms)), ms);
      }),
    ]);
  } finally {
    // Always clear it, or a pending timer keeps the event loop alive and the
    // process will not exit - which for a cron container means the NEXT run
    // starts inside a process that should already be gone.
    if (timer) clearTimeout(timer);
  }
}
