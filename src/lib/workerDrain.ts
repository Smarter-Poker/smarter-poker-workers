import type { ServerType } from '@hono/node-server';

// Jobs can outlive their client connection. Track their promises as well as
// the HTTP server so a disconnected dispatcher cannot make a deploy lose work.
export class WorkerDrain {
  private draining = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly idleWaiters = new Set<() => void>();

  async fetch(work: () => Response | Promise<Response>): Promise<Response> {
    if (this.draining) {
      return new Response('Worker is draining', {
        status: 503, headers: { 'Retry-After': '30', Connection: 'close' },
      });
    }
    return this.track(Promise.resolve().then(work));
  }

  track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    const finished = () => {
      this.pending.delete(work);
      if (this.pending.size === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    };
    // Handle both outcomes without creating an unobserved rejecting finally.
    void work.then(finished, finished);
    return work;
  }

  begin(): void { this.draining = true; }

  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
    }
  }
}

// Below Docker's ten-minute grace, leaving time for process termination.
export const WORKER_DRAIN_DEADLINE_MS = 9 * 60_000;

export function installWorkerShutdown(
  server: ServerType,
  drain: WorkerDrain,
  stopBackground: () => void,
  deadlineMs = WORKER_DRAIN_DEADLINE_MS,
): void {
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      drain.begin();
      console.log(`[workers] received ${signal}; draining accepted jobs`);
      const deadline = setTimeout(() => {
        console.error('[workers] shutdown deadline exceeded; accepted work did not finish');
        process.exit(1);
      }, deadlineMs);
      // Keep the deadline alive if a broken operation is only a pending promise.
      void (async () => {
        try {
          stopBackground();
          const closed = new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
          });
          await Promise.all([closed, drain.whenIdle()]);
          clearTimeout(deadline);
          console.log('[workers] accepted jobs and completion records drained');
          process.exit(0);
        } catch (error) {
          console.error('[workers] shutdown failed:', error);
          clearTimeout(deadline);
          process.exit(1);
        }
      })();
    });
  }
}
