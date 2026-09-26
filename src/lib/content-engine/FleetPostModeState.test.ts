import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  result: { data: [] as unknown[], error: null as { message: string } | null },
}));

vi.mock('../supabase.js', () => ({
  getSupabase: () => {
    const query = {
      select: vi.fn(() => query),
      in: vi.fn(async () => mocks.result),
    };
    return { from: vi.fn(() => query) };
  },
}));

import { _resetPostModes, readPostModeStates } from './Fleet.js';

beforeEach(() => {
  _resetPostModes();
  mocks.result = { data: [], error: null };
});

describe('authoritative horse post mode state', () => {
  it('returns the exact enabled and disabled rows', async () => {
    mocks.result.data = [
      { mode: 'poker_video', enabled: true },
      { mode: 'sports_video', enabled: false },
    ];
    await expect(readPostModeStates(['poker_video', 'sports_video'])).resolves.toEqual({
      poker_video: true,
      sports_video: false,
    });
  });

  it('keeps a database outage distinct from an intentional disable', async () => {
    mocks.result = { data: [], error: { message: 'connection refused' } };
    await expect(readPostModeStates(['poker_video', 'sports_video']))
      .rejects.toThrow('horse post modes unreadable: connection refused');
  });

  it('rejects a partial or malformed control snapshot', async () => {
    mocks.result.data = [{ mode: 'poker_video', enabled: false }];
    await expect(readPostModeStates(['poker_video', 'sports_video']))
      .rejects.toThrow('horse post modes missing: sports_video');

    mocks.result.data = [
      { mode: 'poker_video', enabled: true },
      { mode: 'sports_video', enabled: null },
    ];
    await expect(readPostModeStates(['poker_video', 'sports_video']))
      .rejects.toThrow('horse post mode sports_video is malformed');
  });
});
