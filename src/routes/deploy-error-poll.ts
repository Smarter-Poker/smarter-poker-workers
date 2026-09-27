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
    // Step 1: fetch deployments (10s timeout)
    const step1Abort = new AbortController();
    const step1Timeout = setTimeout(() => step1Abort.abort(), 10000);
    let deploymentsRes: Response;
    try {
      deploymentsRes = await fetch(
        `https://api.vercel.com/v6/deployments?projectId=${PROJECT_ID}&teamId=${TEAM_ID}&limit=25`,
        { headers: { Authorization: `Bearer ${vercelToken}` }, signal: step1Abort.signal },
      );
    } catch (error) {
      await recordDeploymentMonitorHealth('firing', {
        summary: 'Deployment monitoring cannot reach Vercel',
        failureClass: error instanceof Error ? error.name : 'unknown', projectId: PROJECT_ID, teamId: TEAM_ID,
      });
      throw error;
    } finally {
      clearTimeout(step1Timeout);
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
