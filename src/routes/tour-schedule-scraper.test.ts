/**
 * Unit tests for tour-schedule-scraper route
 * Ported work item 3 — verifies handler wiring + auth gate
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { OperationalAlertDeliveryError } from '../lib/operationalAlerts.js';
import { evaluateAndAlert, alertScraperCritical } from '../lib/scraperAlerts.js';
import { tourScheduleScraperHandler } from '../routes/tour-schedule-scraper.js';

// Supabase mock
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: async () => ({ data: [], error: null }) }),
      insert: async () => ({ data: null, error: null }),
      upsert: async () => ({ data: null, error: null }),
    }),
  }),
}));

// Prevent real HTTP calls in lib imports
vi.mock('../lib/tourPdfExtractor.js', () => ({
  extractPdfSchedule: async () => ({ events: [], pages: 0, rawTextLength: 0, error: null }),
  isPdfUrl: () => false,
  findPdfLinks: () => [],
  extractMsptPdfLinks: () => [],
}));

vi.mock('../lib/tourHtmlExtractor.js', () => ({
  fetchAndExtract: async () => ({ events: [], source: 'mock', llm_used: false, error: null }),
  fetchHtml: async () => '<html></html>',
}));

vi.mock('../lib/scraperAlerts.js', () => ({
  evaluateAndAlert: vi.fn(async () => ({ sent: false, reason: 'mock' })),
  alertScraperCritical: vi.fn(async () => ({ sent: false, reason: 'mock' })),
}));

function buildApp(secret?: string) {
  const app = new Hono();
  if (secret) process.env.CRON_SECRET = secret;
  else delete process.env.CRON_SECRET;
  process.env.NODE_ENV = 'production';
  app.get('/cron/tour-schedule-scraper', tourScheduleScraperHandler);
  app.post('/cron/tour-schedule-scraper', tourScheduleScraperHandler);
  return app;
}

describe('tour-schedule-scraper', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when CRON_SECRET set and missing Authorization header', async () => {
    const app = buildApp('secret123');
    const res = await app.request('/cron/tour-schedule-scraper');
    expect(res.status).toBe(401);
  });

  it('passes auth when Authorization header matches', async () => {
    const app = buildApp('secret123');
    const res = await app.request('/cron/tour-schedule-scraper', {
      headers: { Authorization: 'Bearer secret123' },
    });
    // Supabase returns empty — handler will fail gracefully with 500 or 200+empty
    expect([200, 500]).toContain(res.status);
  });

  it('passes auth when no CRON_SECRET configured', async () => {
    const app = buildApp(undefined);
    const res = await app.request('/cron/tour-schedule-scraper');
    expect([200, 500]).toContain(res.status);
  });

  it('returns 503 when an otherwise completed scrape cannot persist its alert', async () => {
    vi.mocked(evaluateAndAlert).mockRejectedValueOnce(new OperationalAlertDeliveryError('queue unavailable'));
    const res = await buildApp().request('/cron/tour-schedule-scraper');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, error: expect.stringContaining('queue unavailable') });
    expect(alertScraperCritical).not.toHaveBeenCalled();
  });

  it('handler exports a function', () => {
    expect(typeof tourScheduleScraperHandler).toBe('function');
  });
});
