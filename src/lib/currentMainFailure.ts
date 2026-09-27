/**
 * Which main deployment, if any, is a current World Hub build failure.
 *
 * Only a settled build (READY or ERROR) says anything about main. QUEUED,
 * INITIALIZING, BUILDING and CANCELED builds have no verdict yet, so they are
 * skipped rather than treated as a reason to look further back for an ERROR.
 *
 * Invariant: an ERROR is reported only when it is the newest settled main
 * deployment. An ERROR that a newer READY main deployment superseded is history
 * and is never returned, so an in-progress build can no longer resurrect it.
 * (On 2026-09-26 14:30Z a BUILDING main deploy made the poll re-report the
 * 2026-09-23 failure dpl_GRd2kSNMxpHbhdttcVZ1jAQSJjCR although five READY
 * production builds had replaced it.)
 */
export interface MainDeploymentCandidate {
  uid: string;
  state: string;
  createdAt?: number;
  meta?: { githubCommitRef?: string; githubCommitSha?: string; githubCommitMessage?: string };
}

export type MainDeploymentVerdict<T extends MainDeploymentCandidate> =
  | { kind: 'ready'; deployment: T }
  | { kind: 'failed'; deployment: T }
  | { kind: 'unsettled'; checked: number };

/** `deployments` is in Vercel's order: newest first. */
export function currentMainFailure<T extends MainDeploymentCandidate>(deployments: readonly T[]): MainDeploymentVerdict<T> {
  const main = deployments.filter((d) => d.meta?.githubCommitRef === 'main');
  const latestSettled = main.find((d) => d.state === 'READY' || d.state === 'ERROR');
  if (!latestSettled) return { kind: 'unsettled', checked: main.length };
  return latestSettled.state === 'ERROR'
    ? { kind: 'failed', deployment: latestSettled }
    : { kind: 'ready', deployment: latestSettled };
}
