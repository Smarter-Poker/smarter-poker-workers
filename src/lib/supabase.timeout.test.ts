/**
 * Every PostgREST call this process makes has a ceiling.
 *
 * The collusion scan gave its READ a wall-clock budget and gave nothing else
 * one - not the horse lookup, not the findings insert, not the RPC that moves
 * the mark - and the client had no timeout of any kind. So a call that never
 * came back hung the handler forever, and the only trace was a row stuck at
 * `running` in cron_execution_log with no error, no log line, and nothing
 * naming which call it was, until the stale sweeper marked it `killed` half
 * an hour later.
 *
 * That is the outage this scan was rewritten to fix, one layer down: not
 * slow, never finished, nothing said so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV = { ...process.env };

describe('the supabase client cannot hang forever', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
    process.env.SUPABASE_REQUEST_TIMEOUT_MS = '40';
  });
  afterEach(() => {
    process.env = { ...ENV };
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('gives every request an AbortSignal with a deadline on it', async () => {
    // WHAT THIS DOES AND DOES NOT BUY. Measured 2026-09-04: with a fetch that
    // only settles when aborted, the abort DOES fire here - and the
    // supabase-js call above it still never settles, and re-issues the
    // request. So a fetch timeout alone does not stop a hang, which is why
    // every awaited call in the scan is wrapped in withDeadline as well.
    //
    // What this layer is for is the socket: without it a stuck connection is
    // held open for as long as the process lives.
    let sawSignal = false;
    let aborted = false;
    vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => {
      sawSignal = !!init?.signal;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });
    const { getSupabase } = await import('./supabase.js');
    // A PostgREST builder is a lazy thenable: nothing is sent until it is
    // awaited or subscribed to. `void` on its own issues no request at all.
    getSupabase()
      .from('profiles')
      .select('id')
      .limit(1)
      .then(
        () => {},
        () => {},
      );
    await new Promise((r) => setTimeout(r, 250));
    expect(sawSignal).toBe(true);
    expect(aborted).toBe(true);
  });

  it('does not retry, because an aborted write may already have run', async () => {
    // Club Arena CLAUDE.md section 2: retry only pre-execution 503s, never
    // anything that may have executed. A timeout is a loud failure here, not
    // a recovery - so exactly one attempt reaches the network.
    let calls = 0;
    vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    });
    const { getSupabase } = await import('./supabase.js');
    await getSupabase().from('collusion_tracking').insert([{ a: 1 }]);
    expect(calls).toBe(1);
  });

  it('passes a normal response straight through', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify([{ id: 'x' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const { getSupabase } = await import('./supabase.js');
    const { data, error } = await getSupabase().from('profiles').select('id').limit(1);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: 'x' }]);
  });
});
