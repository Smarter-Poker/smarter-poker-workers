import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { requireCronSecret } from '../middleware/auth.js';
import { triviaTournamentRounds } from './trivia-tournament-rounds.js';
import { triviaTournaments } from './trivia-tournaments.js';

vi.mock('../lib/supabase.js', () => ({
  getSupabase: vi.fn(() => {
    throw new Error('retired route attempted database access');
  }),
}));

const originalCronSecret = process.env.CRON_SECRET;
const testSecret = 'test-cron-secret';
const routes = [
  {
    path: '/cron/trivia-tournaments',
    handler: triviaTournaments,
    error: 'trivia_tournaments_route_retired',
  },
  {
    path: '/cron/trivia-tournament-rounds',
    handler: triviaTournamentRounds,
    error: 'trivia_tournament_rounds_route_retired',
  },
] as const;

function buildApp(path: string, handler: Parameters<Hono['get']>[1]) {
  const app = new Hono();
  app.use('/cron/*', requireCronSecret);
  app.get(path, handler);
  app.post(path, handler);
  return app;
}

afterAll(() => {
  if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalCronSecret;
});

describe('retired Trivia tournament workers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = testSecret;
  });

  for (const route of routes) {
    it(`${route.path} rejects unauthenticated calls`, async () => {
      const response = await buildApp(route.path, route.handler).request(route.path);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
      expect(getSupabase).not.toHaveBeenCalled();
    });

    it.each(['GET', 'POST'] as const)(
      `${route.path} returns an authenticated 410 tombstone for %s`,
      async (method) => {
        const response = await buildApp(route.path, route.handler).request(route.path, {
          method,
          headers: { Authorization: `Bearer ${testSecret}` },
        });

        expect(response.status).toBe(410);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        await expect(response.json()).resolves.toMatchObject({
          success: false,
          retired: true,
          diamonds_moved: 0,
          error: route.error,
        });
        expect(getSupabase).not.toHaveBeenCalled();
      },
    );
  }

  it('contains no executable database or diamond mutation path', async () => {
    for (const filename of ['trivia-tournaments.ts', 'trivia-tournament-rounds.ts']) {
      const raw = await import('node:fs/promises').then((fs) =>
        fs.readFile(new URL(`./${filename}`, import.meta.url), 'utf8'),
      );
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

      expect(code).not.toContain('getSupabase');
      expect(code).not.toContain('add_diamonds_to_balance');
      expect(code).not.toContain("from('trivia_");
      expect(code).not.toContain('.rpc(');
    }
  });
});
