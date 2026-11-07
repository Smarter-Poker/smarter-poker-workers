/**
 * Observe Vercel deployment failures through the existing operational inbox.
 *
 * The September 17 owner policy retired scheduled release repair. This route
 * retains its authenticated schedule and durable incident delivery, but cannot
 * cancel, initiate, retry, modify or certify a deployment. In particular it must
 * not query the removed autofix kill switch or dispatch the retired publisher.
 */
import type { Context } from 'hono';
import { recordDeploymentMonitorHealth } from '../lib/deploymentMonitorHealth.js';
import { currentMainFailure } from '../lib/currentMainFailure.js';
import { OperationalAlertDeliveryError, operationalEventKey, recordOperationalAlert } from '../lib/operationalAlerts.js';

const TEAM_ID = 'team_SVD8r7AOPH065G3usBxVvrBc';
const PROJECT_ID = 'prj_op66GkZyZcygXQKm76iyycfVFAQx';
const GITHUB_OWNER = 'Smarter-Poker';
const GITHUB_REPO = 'Smarter-Poker-World-Hub';

async function recordDeployAlert(deployId: string, title: string, message: string): Promise<void> {
  await recordOperationalAlert({
    source: 'workers.deploy-error-poll',
    eventKey: operationalEventKey(deployId, title),
    alertname: title.replace(/[^A-Za-z0-9]+/g, ''),
    status: 'firing',
    severity: 'critical',
    payload: { deploymentId: deployId, summary: title, message, repository: `${GITHUB_OWNER}/${GITHUB_REPO}` },
  });
}


export const VERCEL_READ_ATTEMPTS = 3;
const VERCEL_READ_TIMEOUT_MS = 15000;
const VERCEL_READ_BACKOFF_MS = [1000, 3000];

const retryableStatus = (status: number) => status === 429 || status >= 500;

/**
 * Reads the project's latest deployments, retrying a transient failure inside
 * this poll. Returns the last response (ok or a non-retryable / final status);
 * throws the last network or timeout error when every attempt failed to answer.
 */
export async function readVercelDeployments(
  token: string,
  { fetchImpl = fetch, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) }:
    { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= VERCEL_READ_ATTEMPTS; attempt++) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), VERCEL_READ_TIMEOUT_MS);
    try {
      const res = await fetchImpl(
        `https://api.vercel.com/v6/deployments?projectId=${PROJECT_ID}&teamId=${TEAM_ID}&limit=25`,
        { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal },
      );
      if (res.ok || !retryableStatus(res.status) || attempt === VERCEL_READ_ATTEMPTS) return res;
      await res.text().catch(() => '');
    } catch (error) {
      lastError = error;
      if (attempt === VERCEL_READ_ATTEMPTS) throw error;
    } finally {
      clearTimeout(timer);
    }
    await sleep(VERCEL_READ_BACKOFF_MS[attempt - 1] ?? 3000);
  }
  throw lastError;
}

interface VercelDeployment {
  uid: string;
  state: string;
  createdAt: number;
  meta?: {
    githubCommitRef?: string;
    githubCommitSha?: string;
    githubCommitMessage?: string;
  };
}

export async function deployErrorPoll(c: Context) {
  const vercelToken = process.env.VERCEL_TOKEN?.trim();

  if (!vercelToken) {
    if (process.env.NODE_ENV === 'production') {
      try {
        await recordDeploymentMonitorHealth('firing', {
          summary: 'Deployment monitoring has no Vercel credential', projectId: PROJECT_ID, teamId: TEAM_ID,
        });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 503);
      }
      return c.json({ error: 'VERCEL_TOKEN is missing; deployment monitoring is unavailable' }, 503);
    }
    return c.json({ action: 'skipped', message: 'VERCEL_TOKEN not configured — deploy-error-poll disabled on this host' });
  }

  try {
    // Step 1: fetch deployments. ONE SLOW ANSWER IS NOT AN OUTAGE (2026-11-07):
    // on 2026-11-05 18:00-18:22Z every poll alternated between a 10 s
    // AbortError and a clean read, so each single slow Vercel answer filed a
    // critical DeploymentMonitorUnavailable and the next poll resolved it. A
    // read now gets up to three attempts in the same poll (15 s each, 1 s and
    // 3 s apart) for a network failure, a timeout, HTTP 429 or a 5xx; only a
    // poll whose every attempt fails reports the monitor unavailable. A 4xx
    // other than 429 (a bad credential, a wrong project) is reported at once.
    let deploymentsRes: Response;
    try {
      deploymentsRes = await readVercelDeployments(vercelToken);
    } catch (error) {
      await recordDeploymentMonitorHealth('firing', {
        summary: 'Deployment monitoring cannot reach Vercel',
        failureClass: error instanceof Error ? error.name : 'unknown',
        attempts: VERCEL_READ_ATTEMPTS, projectId: PROJECT_ID, teamId: TEAM_ID,
      });
      throw error;
    }

    if (!deploymentsRes.ok) {
      const errText = await deploymentsRes.text();
      await recordDeploymentMonitorHealth('firing', {
        summary: `Deployment monitoring cannot read Vercel (HTTP ${deploymentsRes.status})`,
        details: errText.substring(0, 200), projectId: PROJECT_ID, teamId: TEAM_ID,
      });
      return c.json(
        { error: `Vercel API error: ${deploymentsRes.status}`, details: errText.substring(0, 200) },
        500,
      );
    }

    const data = (await deploymentsRes.json().catch(() => null)) as { deployments?: VercelDeployment[] } | null;
    if (!data || !Array.isArray(data.deployments)) {
      await recordDeploymentMonitorHealth('firing', {
        summary: 'Vercel deployment monitoring returned an invalid response',
        projectId: PROJECT_ID, teamId: TEAM_ID,
      });
      return c.json({ error: 'Vercel response did not contain a deployments array' }, 502);
    }
    await recordDeploymentMonitorHealth('resolved', {
      summary: 'Deployment monitoring can read Vercel again',
      projectId: PROJECT_ID, teamId: TEAM_ID, deploymentsRead: data.deployments.length,
    });
    // Vercel returns newest first. Only the newest settled main build speaks for
    // main: an in-progress build is not a reason to re-report an ERROR that a
    // newer READY build already superseded (see currentMainFailure). Nothing
    // here resolves an earlier incident: a READY successor is not a claim that
    // historical incidents were fixed.
    const verdict = currentMainFailure(data.deployments);
    if (verdict.kind === 'ready') {
      return c.json({ action: 'ok', message: 'Latest settled main deployment is READY',
        latestSha: verdict.deployment.meta?.githubCommitSha?.substring(0, 9) });
    }
    if (verdict.kind === 'unsettled') {
      return c.json({ action: 'ok', message: 'No settled main deployment found', checked: verdict.checked });
    }
    const latestError = verdict.deployment;
    const deployId = latestError.uid;
    const commitSha = latestError.meta?.githubCommitSha ?? '';
    const commitMsg = latestError.meta?.githubCommitMessage ?? '';
    await recordDeployAlert(deployId, 'Vercel Deployment Failed',
      `Deployment ${deployId} failed for commit ${commitSha}. ${commitMsg}`);
    // Preserve the existing identity when an old autofix-created build fails.
    // Durable acknowledgement precedes success; no in-memory suppression.
    if (commitMsg.includes('[autofix]')) {
      await recordDeployAlert(deployId, 'Autofix Rebuild Failed',
        `The autofix commit ${commitSha.substring(0, 9)} itself failed to build. Manual intervention may be needed.`);
    }
    return c.json({ action: 'reported', deployId, commitSha, releaseAction: 'none' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[deploy-error-poll] Observation failed:', message);
    return c.json({ error: message }, error instanceof OperationalAlertDeliveryError ? 503 : 500);
  }
}
