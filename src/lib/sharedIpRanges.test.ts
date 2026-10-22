import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  parseAppleEgressCsv,
  refreshOneStaleSource,
  toIpv4Cidr,
  REFRESH_EVERY_MS,
  __resetSharedIpFailuresForTests,
  type SharedIpSource,
} from './sharedIpRanges.js';

describe('toIpv4Cidr', () => {
  it('normalises IPv4 and refuses everything else', () => {
    expect(toIpv4Cidr('172.224.0.0/12')).toBe('172.224.0.0/12');
    expect(toIpv4Cidr(' 1.2.3.4 ')).toBe('1.2.3.4/32');
    expect(toIpv4Cidr('2a02:26f7::/48')).toBeNull();
    expect(toIpv4Cidr('300.1.1.1/8')).toBeNull();
    expect(toIpv4Cidr('1.2.3.4/33')).toBeNull();
    expect(toIpv4Cidr('')).toBeNull();
  });
});

describe('parseAppleEgressCsv', () => {
  it('keeps the IPv4 ranges once each', () => {
    const csv = [
      '172.224.226.0/27,GB,GB-EN,London,',
      '172.224.226.0/27,GB,GB-EN,London,',
      '2a02:26f7:b3c0:4000::/64,GB,GB-EN,London,',
      '146.75.155.0/24,US,US-IL,Chicago,',
      '',
    ].join('\n');
    expect(parseAppleEgressCsv(csv)).toEqual(['172.224.226.0/27', '146.75.155.0/24']);
  });
});

function fakeSupabase(sources: Array<{ source: string; refreshed_at: string }>) {
  const rpc = vi.fn().mockResolvedValue({ data: 3, error: null });
  const eq = vi.fn().mockResolvedValue({ error: null });
  const client = {
    rpc,
    from: () => ({
      select: () => Promise.resolve({ data: sources, error: null }),
      update: () => ({ eq }),
    }),
  };
  return { client: client as never, rpc, eq };
}

const now = new Date('2026-10-22T19:00:00Z');
const src = (name: string, list: string[], min = 1): SharedIpSource => ({
  source: name,
  label: name,
  minRanges: min,
  load: async () => list,
});

describe('refreshOneStaleSource', () => {
  beforeEach(() => __resetSharedIpFailuresForTests());

  it('a failing source does not starve the next one', async () => {
    const { client, rpc } = fakeSupabase([]);
    const failing: SharedIpSource = {
      source: 'f',
      label: 'f',
      minRanges: 1,
      load: async () => {
        throw new Error('down');
      },
    };
    const sources = [failing, src('g', ['9.9.9.0/24'])];
    expect((await refreshOneStaleSource(client, { now, sources })).source).toBe('f');
    expect((await refreshOneStaleSource(client, { now, sources })).source).toBe('g');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('refreshes the stalest due source only, in one replace', async () => {
    const { client, rpc } = fakeSupabase([
      { source: 'a', refreshed_at: new Date(now.getTime() - REFRESH_EVERY_MS - 1000).toISOString() },
    ]);
    const out = await refreshOneStaleSource(client, {
      now,
      sources: [src('a', ['1.1.1.0/24']), src('b', ['2.2.2.0/24', '3.3.3.0/24'])],
    });
    expect(out.source).toBe('b'); // never refreshed is older than a week ago
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_source: 'b', p_first: true });
  });

  it('does nothing when every source is fresh', async () => {
    const { client, rpc } = fakeSupabase([{ source: 'a', refreshed_at: now.toISOString() }]);
    const out = await refreshOneStaleSource(client, { now, sources: [src('a', ['1.1.1.0/24'])] });
    expect(out.skipped).toBe('all sources fresh');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('keeps the previous list when a download is broken or too small', async () => {
    const { client, rpc } = fakeSupabase([]);
    const broken: SharedIpSource = {
      source: 'x',
      label: 'x',
      minRanges: 1,
      load: async () => {
        throw new Error('offline');
      },
    };
    expect((await refreshOneStaleSource(client, { now, sources: [broken] })).error).toMatch(/offline/);
    expect((await refreshOneStaleSource(client, { now, sources: [src('y', ['1.1.1.0/24'], 50)] })).error).toMatch(
      /previous list kept/,
    );
    expect(rpc).not.toHaveBeenCalled();
  });
});
