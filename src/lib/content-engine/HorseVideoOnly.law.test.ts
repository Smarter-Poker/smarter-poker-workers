import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { videoKindOrder } from './HorsePublisher.js';

const publisher = fs.readFileSync(
  fileURLToPath(new URL('./HorsePublisher.ts', import.meta.url)),
  'utf8',
);

describe('the isolated horse Reels producer remains video-only', () => {
  it('the public entry point has no news, grounded, or mixed-publisher fallback', () => {
    const start = publisher.indexOf('export async function publishVideoForHorse');
    const end = publisher.indexOf('\nasync function postNewsLink', start);
    const body = publisher.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain('publishVideoClip');
    expect(body).toContain("postModeEnabled(`${kind}_video`)");
    expect(body).not.toContain('postNewsLink');
    expect(body).not.toContain('postGrounded');
    expect(body).not.toContain('publishForHorse(');
    expect(body).not.toContain('engineEnabled');
  });

  it('topic selection is stable across retries and cannot escape the approved set', () => {
    const now = new Date('2026-09-26T14:00:00.000Z');
    const first = videoKindOrder('horse-a', now, ['poker', 'sports']);
    expect(videoKindOrder('horse-a', now, ['poker', 'sports'])).toEqual(first);
    expect(new Set(first)).toEqual(new Set(['poker', 'sports']));
    expect(videoKindOrder('horse-a', now, ['sports'])).toEqual(['sports']);
    expect(videoKindOrder('horse-a', now, [])).toEqual([]);
  });

  it('the video write path cannot fall back to a direct social_posts insert', () => {
    const start = publisher.indexOf('export async function publishVideoClip');
    const end = publisher.indexOf('\n/** A stable video preference order', start);
    const body = publisher.slice(start, end);
    expect(body).toContain('publishHorseVideoAtomically');
    expect(body).not.toContain(".from('social_posts')");
    expect(body).not.toContain(".from('social_reels')");
  });

  it('neither publisher falls through after an atomic outcome becomes unknown', () => {
    const isolatedStart = publisher.indexOf('export async function publishVideoForHorse');
    const isolatedEnd = publisher.indexOf('\nasync function postNewsLink', isolatedStart);
    const isolated = publisher.slice(isolatedStart, isolatedEnd);
    expect(isolated).toMatch(/publishVideoClip[\s\S]*result\.outcome === 'unknown'[\s\S]*return result/);

    const mixedStart = publisher.indexOf('export async function publishForHorse');
    const mixed = publisher.slice(mixedStart);
    expect(mixed).toMatch(/publishVideoClip[\s\S]*result\.outcome === 'unknown'[\s\S]*return result/);
  });
});
