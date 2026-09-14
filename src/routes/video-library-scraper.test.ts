import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { videoLibraryScraper } from './video-library-scraper.js';
import { isCronExecutionRequest } from '../lib/cronResultSummary.js';

const db = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  auditError: null as null | { code?: string; message: string },
  readError: null as null | { message: string },
  alertError: null as null | { message: string },
  omitReceipt: false, alerts: [] as unknown[],
}));
vi.mock('../lib/supabase.js', () => ({ getSupabase: () => ({
  rpc: async (_name: string, args: unknown) => {
    db.alerts.push(args);
    return { data: db.alertError ? null : 123, error: db.alertError };
  },
  from: (table: string) => {
    let row: Record<string, unknown> | undefined;
    let id = '';
    const q = {
      insert: (value: Record<string, unknown>) => { row = value; return q; },
      select: (_cols: string, opts?: { head?: boolean }) => opts?.head
        ? Promise.resolve({ count: 42, data: null, error: db.readError }) : q,
      eq: (key: string, value: string) => { if (key === 'id') id = value; return q; },
      order: () => q,
      limit: () => Promise.resolve({ data: [], error: db.readError }),
      maybeSingle: async () => {
        if (!row) return { data: db.rows.get(id), error: db.readError };
        if (db.auditError) return { data: null, error: db.auditError };
        if (db.rows.has(String(row.id))) return { data: null, error: { code: '23505', message: 'duplicate' } };
        db.rows.set(String(row.id), structuredClone(row));
        return { data: db.omitReceipt ? null : { id: row.id }, error: null };
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({
        data: table === 'video_library_videos' ? [{ source_id: 'HCL' }] : [], error: db.readError,
      })),
    };
    return q;
  },
}) }));

const runId = '52680c63-8e37-41f8-9c8c-b2aa043017ee';
const report = () => ({ run_id: runId, scope: 'full', ran_at: new Date(Date.now() - 10_000).toISOString(),
  completed_at: new Date().toISOString(), elapsed_s: 10,
  processed: 43, failed: 0, total_found: 1398, total_new: 18,
  insert_failed: 0, metadata_failed: 0, errors: [] as string[],
});
let executed: number;
let app: Hono;
beforeEach(() => {
  db.rows.clear(); db.alerts.length = 0;
  db.auditError = db.readError = db.alertError = null; db.omitReceipt = false;
  executed = 0;
  app = new Hono();
  app.use('/cron/*', async (c, next) => {
    const body = c.req.method === 'POST' ? await c.req.json().catch(() => null) : null;
    if (isCronExecutionRequest(c.req.method, c.req.path, body?.scope)) executed++;
    await next();
  });
  app.all('/cron/video-library-scraper', videoLibraryScraper);
});
const post = (body: unknown, suffix = '?report=1') => app.request('/cron/video-library-scraper' + suffix,
  { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } });

describe('video scrape result authority', () => {
  it('does not turn a status read into a successful daily execution', async () => {
    const res = await app.request('/cron/video-library-scraper');
    expect(res.status).toBe(200); expect((await res.json()).total_videos).toBe(42);
    expect(executed).toBe(0); expect(db.rows.size).toBe(0);
    expect(isCronExecutionRequest('GET', '/cron/pokernews-videos')).toBe(true);
  });
  it('refuses status-query errors rather than reporting an empty healthy library', async () => {
    db.readError = { message: 'database read unavailable' };
    expect((await app.request('/cron/video-library-scraper')).status).toBe(503);
  });
  it('records a single-source report without freshening the full daily job', async () => {
    const res = await post({ ...report(), scope: 'source', source_id: 'HCL' });
    expect(res.status).toBe(200); expect(db.rows.size).toBe(1); expect(executed).toBe(0);
  });
  it.each(['{', 'null', '[]', '{}'])('refuses malformed reports %s', async (body) => {
    expect((await post(body)).status).toBe(400); expect(db.rows.size).toBe(0);
  });
  it('rejects reports over the payload limit', async () => {
    expect((await post('x'.repeat(32_001))).status).toBe(400);
  });
  it.each([
    { failed: -1 }, { metadata_failed: true }, { insert_failed: 0.5 }, { scope: 'unknown' },
    { run_id: 'not-a-run' }, { elapsed_s: -1 }, { errors: [null] },
    { completed_at: '2020-01-01T00:00:00Z' }, { completed_at: '2999-01-01T00:00:00Z' },
  ])('rejects invalid or historical reports %j', async (change) => {
    expect((await post({ ...report(), ...change })).status).toBe(400); expect(db.rows.size).toBe(0);
  });
  it('acknowledges only an exact committed audit identity', async () => {
    const res = await post(report());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: true, success: true, run_id: runId, audit_id: runId });
    expect(executed).toBe(1); expect(db.rows.size).toBe(1); expect(db.alerts).toEqual([]);
  });
  it.each([{ failed: 1 }, { insert_failed: 1 }, { metadata_failed: 100 }, { errors: ['metadata process timeout'] }])(
    'records each failure in the operational inbox and returns failed execution %j', async (change) => {
      const res = await post({ ...report(), ...change });
      expect(res.status).toBe(503); expect(await res.json()).toMatchObject({ accepted: true, success: false });
      expect(db.alerts).toHaveLength(1);
      expect(db.alerts[0]).toMatchObject({ p_source: 'video-library-scraper', p_event_key: runId, p_alertname: 'VideoLibraryScrapeFailed' });
    });
  it('does not acknowledge a returned database error', async () => {
    db.auditError = { message: 'disk full' };
    const res = await post(report());
    expect(res.status).toBe(503); expect((await res.json()).accepted).toBe(false);
  });
  it('does not acknowledge a missing commit receipt', async () => {
    db.omitReceipt = true;
    expect((await (await post(report())).json()).accepted).toBe(false);
  });
  it('requires durable alert acceptance for a failed report', async () => {
    db.alertError = { message: 'inbox unavailable' };
    const res = await post({ ...report(), metadata_failed: 1 });
    expect(res.status).toBe(503); expect((await res.json()).accepted).toBe(false);
  });
  it('reuses one audit row after a lost acknowledgement', async () => {
    const body = report(); await post(body);
    expect((await post(body)).status).toBe(200); expect(db.rows.size).toBe(1);
  });
  it('refuses reuse of a run identity for changed results', async () => {
    const body = report(); await post(body);
    expect((await post({ ...body, total_new: 19 })).status).toBe(409);
  });
  it('rejects POST without report mode instead of calling it a scrape', async () => {
    expect((await post(report(), '')).status).toBe(400); expect(db.rows.size).toBe(0);
  });
});
