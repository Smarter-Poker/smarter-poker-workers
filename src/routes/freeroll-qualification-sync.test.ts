import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ type: 'cash_hours', manual: false, writes: [] as Record<string, unknown>[], tables: [] as string[], filters: [] as unknown[][] }));
vi.mock('../lib/supabase.js', () => ({ getSupabase: () => ({ from(table: string) {
  state.tables.push(table);
  const data = () => table === 'commander_freerolls' ? [{ id: 'f', name: 'Fixture', venue_id: 'v', qualification_type: state.type, qualification_period: 'weekly', qualification_threshold: 10, created_at: '2026-10-01T00:00:00Z' }]
    : table === 'commander_player_sessions' ? [{ player_id: 'player', player_name: 'Fixture Player', total_time_minutes: 720 }]
    : table === 'commander_freeroll_qualifications' ? (state.manual ? [{ player_id: 'player', manually_added: true, is_qualified: true }] : [])
    : table === 'commander_tournaments' ? [{ id: 't' }]
    : table === 'commander_tournament_entries' ? [{ player_id: 'player', player_name: 'Fixture Player', finish_position: 1, tournament_id: 't' }] : [];
  const q = {
    select() { return q; }, eq() { return q; }, gte() { return q; }, lte() { return q; }, not() { return q; }, limit() { return q; },
    in(field: string, values: unknown[]) { state.filters.push([field, values]); return q; },
    upsert(payload: Record<string, unknown>) { state.writes.push(payload); return q; },
    then(resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) { return Promise.resolve({ data: data(), error: null }).then(resolve, reject); },
  };
  return q;
} }) }));
import { freerollQualificationSync } from './freeroll-qualification-sync.js';
const app = new Hono(); app.get('/cron/freeroll-qualification-sync', freerollQualificationSync);
beforeEach(() => { state.type = 'cash_hours'; state.manual = false; state.writes = []; state.tables = []; state.filters = []; });

describe('freeroll sync never grants benefits from points', () => {
  it('explicit targeted points modes are retired before tournament reads or qualification writes', async () => {
    state.type = 'tournament_points';
    const response = await app.request('/cron/freeroll-qualification-sync?freeroll_id=f');
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.results[0]).toMatchObject({ status: 'skipped', reason: 'points_rewards_retired' });
    expect(state.tables).toEqual(['commander_freerolls']);
    expect(state.writes).toEqual([]);
  });
  it('ordinary scheduled scan requests cash-hours configurations only', async () => {
    await app.request('/cron/freeroll-qualification-sync');
    expect(state.filters).toContainEqual(['qualification_type', ['cash_hours']]);
  });
  it('cash hours still qualify without overwriting historical point values', async () => {
    const result = await (await app.request('/cron/freeroll-qualification-sync?freeroll_id=f')).json();
    expect(result.synced).toBe(1);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({ hours_logged: 12, is_qualified: true, manually_added: false });
    expect(state.writes[0]).not.toHaveProperty('points_earned');
    expect(state.tables).not.toContain('commander_tournament_entries');
  });
  it('cash-hours manual overrides survive unchanged', async () => {
    state.manual = true;
    await app.request('/cron/freeroll-qualification-sync?freeroll_id=f');
    expect(state.writes).toEqual([]);
  });
  it.each(['open', 'custom'])('%s targeted configurations still skip automatically', async (type) => {
    state.type = type;
    const result = await (await app.request('/cron/freeroll-qualification-sync?freeroll_id=f')).json();
    expect(result.skipped).toBe(1);
    expect(state.writes).toEqual([]);
  });
});

