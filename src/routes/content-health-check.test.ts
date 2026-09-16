import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentHealthCheck } from './content-health-check.js';

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: () => { throw new Error('no fallback succeeded; no database write is expected'); },
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const context = () => ({
  json: (body: unknown) => body,
}) as unknown as Parameters<typeof contentHealthCheck>[0];

describe('content-health local diagnostics', () => {
  it('retains all failed-source results and a local warning', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 503 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await contentHealthCheck(context()) as unknown as {
      success: boolean; healthy: number; failed: number; needs_attention: string[];
    };
    expect(result.success).toBe(false);
    expect(result.healthy).toBe(0);
    expect(result.failed).toBe(7);
    expect(result.needs_attention).toHaveLength(7);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[content-health-check] 7 sources need manual attention',
      expect.objectContaining({ failed_sources: result.needs_attention }),
    );
  });

  it('returns the original failures when the local log sink throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 503 }));
    vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('stderr unavailable'); });
    expect(await contentHealthCheck(context())).toMatchObject({ success: false, failed: 7, healthy: 0 });
  });

  it('keeps healthy-source results quiet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await contentHealthCheck(context())).toMatchObject({ success: true, failed: 0, healthy: 7 });
    expect(warn).not.toHaveBeenCalled();
  });
});
