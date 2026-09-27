import { describe, expect, it } from 'vitest';
import { currentMainFailure } from './currentMainFailure.js';

const main = (uid: string, state: string) => ({ uid, state, meta: { githubCommitRef: 'main', githubCommitSha: `${uid}-sha` } });
const branch = (uid: string, state: string) => ({ uid, state, meta: { githubCommitRef: 'agent/some-branch' } });

describe('currentMainFailure', () => {
  it('never resurrects an ERROR that a newer READY main build superseded while the next build is in progress', () => {
    // 2026-09-26 14:30Z shape: dpl_HhBB building, five READY builds, then the
    // 2026-09-23 ERROR dpl_GRd2k that the old poll re-reported.
    for (const inProgress of ['BUILDING', 'QUEUED', 'INITIALIZING']) {
      const verdict = currentMainFailure([
        main('new', inProgress), main('r1', 'READY'), main('c1', 'CANCELED'), main('r2', 'READY'), main('old-error', 'ERROR'),
      ]);
      expect(verdict).toMatchObject({ kind: 'ready', deployment: { uid: 'r1' } });
    }
  });

  it('keeps reporting a failure that is still the newest settled main build while a retry builds', () => {
    const verdict = currentMainFailure([main('retry', 'BUILDING'), main('broken', 'ERROR'), main('good', 'READY')]);
    expect(verdict).toMatchObject({ kind: 'failed', deployment: { uid: 'broken' } });
  });

  it('reports the newest ERROR when main is currently broken', () => {
    expect(currentMainFailure([main('broken', 'ERROR'), main('good', 'READY')]))
      .toMatchObject({ kind: 'failed', deployment: { uid: 'broken' } });
  });

  it('ignores branch previews and canceled builds entirely', () => {
    expect(currentMainFailure([branch('p1', 'ERROR'), main('c1', 'CANCELED'), main('good', 'READY')]))
      .toMatchObject({ kind: 'ready', deployment: { uid: 'good' } });
    expect(currentMainFailure([branch('p1', 'ERROR'), main('c1', 'CANCELED'), main('b1', 'BUILDING')]))
      .toEqual({ kind: 'unsettled', checked: 2 });
  });
});
