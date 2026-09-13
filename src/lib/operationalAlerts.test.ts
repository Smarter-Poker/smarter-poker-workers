import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OperationalAlertDeliveryError, operationalEventKey, recordOperationalAlert } from './operationalAlerts.js';
import { alertScraperCritical } from './scraperAlerts.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./supabase.js', () => ({ getSupabase: () => ({ rpc }) }));
const event = { source: 'workers.test', eventKey: 'incident-1', alertname: 'WorkerFailed', status: 'firing' as const, severity: 'critical' as const, payload: { summary: 'test failure' } };

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: 17, error: null });
});

describe('durable operational alert delivery', () => {
  it('acknowledges only a persisted receipt and passes the unchanged event identity', async () => {
    await expect(recordOperationalAlert(event)).resolves.toBe('17');
    expect(rpc).toHaveBeenCalledWith('fn_record_operational_alert', {
      p_source: event.source, p_event_key: event.eventKey, p_alertname: event.alertname,
      p_status: event.status, p_severity: event.severity, p_payload: event.payload,
    });
  });

  it.each([
    { data: null, error: { message: 'database unavailable' } },
    { data: null, error: null },
    { data: 0, error: null },
  ])('rejects an unacknowledged event (%j)', async (result) => {
    rpc.mockResolvedValue(result);
    await expect(recordOperationalAlert(event)).rejects.toBeInstanceOf(OperationalAlertDeliveryError);
  });

  it('preserves deterministic, distinct retry identities', () => {
    expect(operationalEventKey('deployment-1', 'failed')).toBe(operationalEventKey('deployment-1', 'failed'));
    expect(operationalEventKey('deployment-1', 'failed')).not.toBe(operationalEventKey('deployment-2', 'failed'));
  });

  it('does not start scraper cooldown after delivery fails; retry retains the same key and full diagnostics', async () => {
    const reason = 'retry test ' + 'diagnostic '.repeat(80);
    const stats = { startedAt: '2026-09-13T16:00:00Z', errors: [{ scraper: 'test', details: 'full evidence' }] };
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'temporarily unavailable' } });
    await expect(alertScraperCritical('test-scraper', reason, stats)).rejects.toBeInstanceOf(OperationalAlertDeliveryError);
    const first = rpc.mock.calls[0][1];
    await expect(alertScraperCritical('test-scraper', reason, stats)).resolves.toMatchObject({ sent: true });
    const second = rpc.mock.calls[1][1];
    expect(second.p_event_key).toBe(first.p_event_key);
    expect(second.p_payload.message).toContain(reason);
    expect(second.p_payload.stats).toEqual(stats);
    expect(second.p_payload.message.length).toBeGreaterThan(480);
    await alertScraperCritical('test-scraper', 'a separate root cause', stats);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls[2][1].p_event_key).not.toBe(second.p_event_key);
  });
});
