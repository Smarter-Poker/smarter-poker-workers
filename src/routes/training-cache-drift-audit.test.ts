import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({ rpc }),
}));

import {
  TRAINING_CACHE_AUDIT_RPC,
  isTrainingCacheAuditResult,
  trainingCacheDriftAudit,
} from './training-cache-drift-audit.js';

const healthyAudit = {
  runDate: '2026-09-07',
  status: 'healthy' as const,
  metrics: {
    activeRows: 142,
    fallbackRows: 18,
    contentDriftRows: 0,
    policyDriftRows: 0,
    classificationDriftRows: 0,
    sourceDriftRows: 0,
    lineageGapRows: 0,
    counterDriftRows: 0,
    rowsQuarantined: 0,
  },
  findings: [],
  runCount: 1,
  startedAt: '2026-09-07T08:10:00.000Z',
  completedAt: '2026-09-07T08:10:00.123Z',
};

function makeContext() {
  let captured: { body?: unknown; status?: number } = {};
  return {
    json(body: unknown, status?: number) {
      captured = { body, status: status ?? 200 };
      return captured;
    },
    get captured() {
      return captured;
    },
  } as unknown as Parameters<typeof trainingCacheDriftAudit>[0] & {
    readonly captured: { body: unknown; status: number };
  };
}

describe('GET/POST /cron/training-cache-drift-audit', () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it('calls the canonical audit RPC and reports a healthy run', async () => {
    rpc.mockResolvedValue({ data: healthyAudit, error: null });
    const context = makeContext();

    await trainingCacheDriftAudit(context);

    expect(rpc).toHaveBeenCalledWith(TRAINING_CACHE_AUDIT_RPC, {});
    expect(context.captured.status).toBe(200);
    expect(context.captured.body).toMatchObject({
      ok: true,
      audit: healthyAudit,
    });
  });

  it.each(['warning', 'critical'] as const)(
    'returns 503 for a %s verdict so Open Claw records a failed run',
    async (status) => {
      rpc.mockResolvedValue({
        data: {
          ...healthyAudit,
          status,
          findings: [{ severity: status, code: 'policy_checksum_drift', count: 1 }],
        },
        error: null,
      });
      const context = makeContext();

      await trainingCacheDriftAudit(context);

      expect(context.captured.status).toBe(503);
      expect(context.captured.body).toMatchObject({
        ok: false,
        audit: { status },
      });
    },
  );

  it('fails closed when the RPC response shape is incomplete', async () => {
    rpc.mockResolvedValue({ data: { status: 'healthy' }, error: null });
    const context = makeContext();

    await trainingCacheDriftAudit(context);

    expect(context.captured.status).toBe(500);
    expect(context.captured.body).toMatchObject({
      ok: false,
      error: 'training cache audit returned an invalid result',
    });
  });

  it('surfaces a database error', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'function is unavailable' } });
    const context = makeContext();

    await trainingCacheDriftAudit(context);

    expect(context.captured.status).toBe(500);
    expect(context.captured.body).toMatchObject({
      ok: false,
      error: 'function is unavailable',
    });
  });

  it('is wired for authenticated GET and POST dispatches', async () => {
    const index = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
    const middleware = index.indexOf("app.use('/cron/*', requireCronSecret)");
    const getRoute = index.indexOf(
      "app.get('/cron/training-cache-drift-audit', trainingCacheDriftAudit)",
    );
    const postRoute = index.indexOf(
      "app.post('/cron/training-cache-drift-audit', trainingCacheDriftAudit)",
    );

    expect(index).toContain(
      "import { trainingCacheDriftAudit } from './routes/training-cache-drift-audit.js'",
    );
    expect(middleware).toBeGreaterThan(-1);
    expect(getRoute).toBeGreaterThan(middleware);
    expect(postRoute).toBeGreaterThan(middleware);
  });

  it('validates the full persisted audit receipt, not only its status', () => {
    expect(isTrainingCacheAuditResult(healthyAudit)).toBe(true);
    expect(isTrainingCacheAuditResult({ ...healthyAudit, runCount: 0 })).toBe(false);
    expect(isTrainingCacheAuditResult({ ...healthyAudit, findings: null })).toBe(false);
    expect(isTrainingCacheAuditResult({ ...healthyAudit, metrics: [] })).toBe(false);
    expect(isTrainingCacheAuditResult({ ...healthyAudit, status: 'ok' })).toBe(false);
  });
});
