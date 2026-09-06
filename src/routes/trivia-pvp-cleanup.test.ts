import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { requireCronSecret } from '../middleware/auth.js';
import { triviaPvpCleanup } from './trivia-pvp-cleanup.js';

vi.mock('../lib/supabase.js', () => ({
  getSupabase: vi.fn(() => {
    throw new Error('retired route attempted database access');
  }),
}));

const originalCronSecret = process.env.CRON_SECRET;
const testSecret = 'test-cron-secret';

function buildApp() {
  const app = new Hono();
  app.use('/cron/*', requireCronSecret);
  app.get('/cron/trivia-pvp-cleanup', triviaPvpCleanup);
  app.post('/cron/trivia-pvp-cleanup', triviaPvpCleanup);
  return app;
}

afterAll(() => {
  if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalCronSecret;
});

describe('GET/POST /cron/trivia-pvp-cleanup (retired)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = testSecret;
  });

  it('rejects a request that does not authenticate', async () => {
    const response = await buildApp().request('/cron/trivia-pvp-cleanup');

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
    expect(getSupabase).not.toHaveBeenCalled();
  });

  it.each(['GET', 'POST'] as const)(
    'returns an authenticated 410 tombstone for %s without touching the database',
    async (method) => {
      const response = await buildApp().request('/cron/trivia-pvp-cleanup', {
        method,
        headers: { Authorization: `Bearer ${testSecret}` },
      });

      expect(response.status).toBe(410);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        retired: true,
        diamonds_moved: 0,
        error: 'trivia_pvp_cleanup_route_retired',
      });
      expect(getSupabase).not.toHaveBeenCalled();
    },
  );

  it('contains no executable database or diamond mutation path', async () => {
    const raw = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./trivia-pvp-cleanup.ts', import.meta.url), 'utf8'),
    );
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect(code).not.toContain('getSupabase');
    expect(code).not.toContain('add_diamonds_to_balance');
    expect(code).not.toContain("from('trivia_pvp_");
    expect(code).not.toContain('.rpc(');
  });
});
