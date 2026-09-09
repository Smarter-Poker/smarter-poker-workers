import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TournamentReminderWorker, dispatchTournamentReminders } from './tournamentReminderWorker.js';

describe('built-in tournament reminder owner', () => {
  const owners: TournamentReminderWorker[] = [];
  const fixture = () => {
    const prepare = vi.fn().mockResolvedValue({ busy: false, queued: 0, next_due_at: null, oldest_pending_at: null });
    const dispatch = vi.fn().mockResolvedValue({ok:true, reminderProtocol:1, claimed:1, sent:1, skipped:0, failed:0, uncertain:0});
    const report = vi.fn();
    const worker = new TournamentReminderWorker({prepare,dispatch,report}); owners.push(worker);
    return {worker,prepare,dispatch,report};
  };
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-09T12:00:00Z')); });
  afterEach(() => { owners.splice(0).forEach(x=>x.stop()); vi.useRealTimers(); });
  it('starts from durable work without any cron invocation', async () => {
    const f=fixture(); f.prepare.mockResolvedValue({busy:false,queued:1,oldest_pending_at:new Date().toISOString()});
    f.worker.start(); await vi.advanceTimersByTimeAsync(0);
    expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.dispatch).toHaveBeenCalledTimes(1); expect(f.worker.snapshot().sent).toBe(1);
  });
  it('a restart reconstructs pending work instead of relying on an old timer', async () => {
    const first=fixture();first.worker.start();await vi.advanceTimersByTimeAsync(0);first.worker.stop();
    const next=fixture();next.prepare.mockResolvedValue({busy:false,queued:0,oldest_pending_at:new Date().toISOString()});
    next.worker.start();await vi.advanceTimersByTimeAsync(0);expect(next.dispatch).toHaveBeenCalledTimes(1);
  });
  it('wakes at the stored deadline and also notices later registrations', async () => {
    const f=fixture(); f.prepare.mockResolvedValueOnce({busy:false,queued:0,next_due_at:new Date(Date.now()+5000).toISOString()});
    f.worker.start();await vi.advanceTimersByTimeAsync(4999);expect(f.prepare).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(f.prepare).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);expect(f.prepare).toHaveBeenCalledTimes(3);
  });
  it('does not overlap a slow prepare or duplicate start', async () => {
    const f=fixture();let resolve!: (value:unknown)=>void;
    f.prepare.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));f.worker.start();f.worker.start();
    await vi.advanceTimersByTimeAsync(60_000);expect(f.prepare).toHaveBeenCalledTimes(1);
    resolve({busy:false,queued:0});await vi.advanceTimersByTimeAsync(0);expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('stopping aborts the old generation and prevents late dispatch', async () => {
    const f=fixture();let resolve!: (value:unknown)=>void;
    f.prepare.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));f.worker.start();f.worker.stop();
    expect(f.prepare.mock.calls[0][0].aborted).toBe(true);
    resolve({busy:false,queued:1,oldest_pending_at:new Date().toISOString()});await vi.advanceTimersByTimeAsync(60_000);
    expect(f.dispatch).not.toHaveBeenCalled();expect(f.prepare).toHaveBeenCalledTimes(1);
  });
  it('retries failures with bounded backoff and reports the first unresolved error', async () => {
    const f=fixture();f.prepare.mockRejectedValue(new Error('unavailable'));f.worker.start();
    await vi.advanceTimersByTimeAsync(999);expect(f.prepare).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(f.prepare).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);expect(f.prepare).toHaveBeenCalledTimes(3);expect(f.report).toHaveBeenCalledTimes(1);
    expect(f.worker.snapshot().status).toBe('retrying');
  });
  it('does not report green for an unknown sender version or unresolved acceptance', async () => {
    const f=fixture();f.prepare.mockResolvedValue({busy:false,queued:0,oldest_pending_at:new Date().toISOString()});
    f.dispatch.mockResolvedValueOnce({ok:true});f.worker.start();await vi.advanceTimersByTimeAsync(0);
    expect(f.worker.snapshot().status).toBe('retrying');
    f.dispatch.mockResolvedValueOnce({ok:false,reminderProtocol:1,claimed:1,sent:0,skipped:0,failed:0,uncertain:1});
    await vi.advanceTimersByTimeAsync(1000);expect(f.worker.snapshot().uncertain).toBe(1);expect(f.worker.snapshot().status).toBe('retrying');
  });
  it('normal contention yields without dispatching or reporting an outage', async () => {
    const f=fixture();f.prepare.mockResolvedValue({busy:true});f.worker.start();await vi.advanceTimersByTimeAsync(0);
    expect(f.dispatch).not.toHaveBeenCalled();expect(f.report).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);expect(f.prepare).toHaveBeenCalledTimes(2);
  });
});

describe('reminder service transport', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it('uses existing database service authority instead of the unrelated local cron credential', async () => {
    vi.stubEnv('CRON_SECRET', 'worker-local-cron-fixture');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'database-service-fixture');
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, reminderProtocol: 1 }) });
    vi.stubGlobal('fetch', fetcher);
    await dispatchTournamentReminders(new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer database-service-fixture');
    expect(fetcher.mock.calls[0][1].method).toBe('POST');
  });
  it('missing service authority cannot fall back to the local cron credential', async () => {
    vi.stubEnv('CRON_SECRET', 'worker-local-cron-fixture'); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(dispatchTournamentReminders(new AbortController().signal)).rejects.toThrow('authority');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('a rejected service request remains a failure', async () => {
    vi.stubEnv('CRON_SECRET', 'worker-local-cron-fixture'); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'database-service-fixture');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(dispatchTournamentReminders(new AbortController().signal)).rejects.toThrow('HTTP 401');
  });
});
