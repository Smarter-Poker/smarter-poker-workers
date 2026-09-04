import { describe, expect, it, vi } from 'vitest';
import { DeadlineExceededError, withDeadline } from './withDeadline.js';

describe('withDeadline', () => {
  it('returns the value when the work finishes in time', async () => {
    await expect(withDeadline(Promise.resolve('ok'), 100, 'x')).resolves.toBe('ok');
  });

  it('rejects when the work never settles, naming the call and the wait', async () => {
    // The production shape: a promise that never settles at all. A fetch-level
    // timeout underneath does not help, because the library above it may
    // swallow the rejection - measured, see the module header.
    const never = new Promise<string>(() => {});
    const started = Date.now();
    await expect(withDeadline(never, 30, 'horse lookup')).rejects.toThrow(
      /horse lookup did not answer within 30ms/,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('passes a real rejection through unchanged', async () => {
    await expect(
      withDeadline(Promise.reject(new Error('connection reset')), 100, 'x'),
    ).rejects.toThrow('connection reset');
  });

  it('is a DeadlineExceededError, so a caller can tell a hang from a failure', async () => {
    const err = await withDeadline(new Promise(() => {}), 10, 'insert').catch((e) => e);
    expect(err).toBeInstanceOf(DeadlineExceededError);
    expect(err.label).toBe('insert');
  });

  it('clears its timer, so a fast call cannot hold the process open', async () => {
    // A cron container that will not exit means the next run starts inside a
    // process that should already be gone.
    vi.useFakeTimers();
    try {
      await withDeadline(Promise.resolve(1), 60_000, 'quick');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
