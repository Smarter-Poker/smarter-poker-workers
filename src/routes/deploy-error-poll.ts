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
import { resolveOpenOperationalAlerts } from '../lib/operationalAlertResolution.js';
import { OperationalAlertDeliveryError, operationalEventKey, recordOperationalAlert } from '../lib/operationalAlerts.js';

const TEAM_ID = 'team_SVD8r7AOPH065G3usBxVvrBc';
const PROJECT_ID = 'prj_op66GkZyZcygXQKm76iyycfVFAQx';
const GITHUB_OWNER = 'Smarter-Poker';
const GITHUB_REPO = 'Smarter-Poker-World-Hub';

export interface DeploymentDiagnostics {
  deploymentState: string;
  errorCode: string | null;
  errorMessage: string | null;
  inspectorUrl: string | null;
  url: string | null;
  commitSha: string | null;
  commitMessage: string | null;
}

const CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const SENSITIVE_QUERY_KEY_RE =
  /(?:^|_|-)(?:token|secret|key|apikey|password|passwd|auth|sig|signature|session|credential|jwt|bearer|code)(?:$|_|-)/i;

function redactSecrets(input: string, runtimeSecrets: readonly string[] = []): string {
  let out = input;
  for (const secret of runtimeSecrets) {
    if (secret.length >= 6 && out.includes(secret)) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  out = out
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1[REDACTED]@')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, '[REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .replace(/\b(?:sk|pk|sb_secret|sbp|vcp|vck|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(
      /\b(token|secret|password|passwd|api[_-]?key|apikey|service[_-]?role[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key)\s*([:=])\s*(['"]?)[^\s'",;)}\]]{4,}\3/gi,
      '$1$2[REDACTED]',
    )
    .replace(
      /([?&](?:token|secret|api[_-]?key|apikey|key|password|passwd|auth|sig|signature|access_token|session)=)[^&\s#'"]+/gi,
      '$1[REDACTED]',
    );
  return out;
}

function sanitizeTextField(value: unknown, maxLength: number, runtimeSecrets: readonly string[] = []): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(CONTROL_CHAR_RE, '').replace(/\r\n?/g, '\n').trim();
  if (!cleaned) return null;
  const redacted = redactSecrets(cleaned, runtimeSecrets).trim();
  if (!redacted) return null;
  return redacted.length > maxLength ? redacted.slice(0, maxLength).trimEnd() : redacted;
}

function stripSensitiveUrlParts(parsed: URL, runtimeSecrets: readonly string[]): void {
  parsed.username = '';
  parsed.password = '';
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (SENSITIVE_QUERY_KEY_RE.test(key)) {
      parsed.searchParams.delete(key);
      continue;
    }
    const values = parsed.searchParams.getAll(key);
    if (values.some((v) => redactSecrets(v, runtimeSecrets) !== v)) {
      parsed.searchParams.delete(key);
    }
  }
  if (parsed.hash && redactSecrets(parsed.hash, runtimeSecrets) !== parsed.hash) {
    parsed.hash = '';
  }
}

function sanitizeUrlField(value: unknown, runtimeSecrets: readonly string[] = []): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(CONTROL_CHAR_RE, '').trim();
  if (!trimmed || trimmed.length > 2048 || /\s/.test(trimmed)) return null;

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  if (hasScheme) {
    if (!/^https?:\/\//i.test(trimmed)) return null;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      stripSensitiveUrlParts(parsed, runtimeSecrets);
      const result = redactSecrets(parsed.toString(), runtimeSecrets);
      return result.length <= 512 ? result : `${parsed.origin}${parsed.pathname}`.slice(0, 512);
    } catch {
      return null;
    }
  }

  // Vercel's `url` field is typically a bare deployment hostname (no scheme).
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(?:[/?#].*)?$/.test(trimmed)) return null;
  try {
    const parsed = new URL(`https://${trimmed}`);
    stripSensitiveUrlParts(parsed, runtimeSecrets);
    const hasPath = trimmed.includes('/');
    const pathname = parsed.pathname === '/' && !hasPath ? '' : parsed.pathname;
    const result = redactSecrets(`${parsed.host}${pathname}${parsed.search}`, runtimeSecrets);
    return result.length <= 512 ? result : result.slice(0, 512);
  } catch {
    return null;
  }
}

function flattenInline(text: string, maxLength: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > maxLength ? flat.slice(0, maxLength).trimEnd() : flat;
}

export function extractDeploymentDiagnostics(
  deployment: VercelDeployment,
  runtimeSecrets: readonly string[] = [],
): DeploymentDiagnostics {
  return {
    deploymentState: sanitizeTextField(deployment.state, 64, runtimeSecrets) ?? 'UNKNOWN',
    errorCode: sanitizeTextField(deployment.errorCode, 128, runtimeSecrets),
    errorMessage: sanitizeTextField(deployment.errorMessage, 1000, runtimeSecrets),
    inspectorUrl: sanitizeUrlField(deployment.inspectorUrl, runtimeSecrets),
    url: sanitizeUrlField(deployment.url, runtimeSecrets),
    commitSha: sanitizeTextField(deployment.meta?.githubCommitSha, 64, runtimeSecrets),
    commitMessage: sanitizeTextField(deployment.meta?.githubCommitMessage, 500, runtimeSecrets),
  };
}

export function formatDeployFailureMessage(deployId: string, diagnostics: DeploymentDiagnostics): string {
  let msg = `Deployment ${deployId} settled as ${diagnostics.deploymentState}`;
  if (diagnostics.commitSha) {
    msg += ` for commit ${diagnostics.commitSha}`;
  }
  if (diagnostics.commitMessage) {
    msg += ` (${flattenInline(diagnostics.commitMessage, 160)})`;
  }
  msg += '.';

  if (diagnostics.errorCode && diagnostics.errorMessage) {
    const detail = flattenInline(diagnostics.errorMessage, 300).replace(/\.+$/, '');
    msg += ` Error [${diagnostics.errorCode}]: ${detail}.`;
  } else if (diagnostics.errorCode) {
    msg += ` Error [${diagnostics.errorCode}].`;
  } else if (diagnostics.errorMessage) {
    const detail = flattenInline(diagnostics.errorMessage, 300).replace(/\.+$/, '');
    msg += ` Error: ${detail}.`;
  }

  if (diagnostics.inspectorUrl) {
    msg += ` Inspector: ${diagnostics.inspectorUrl}`;
  } else if (diagnostics.url) {
    msg += ` URL: ${diagnostics.url}`;
  }
  return msg;
}

async function recordDeployAlert(
  deployId: string,
  title: string,
  message: string,
  diagnostics: DeploymentDiagnostics,
): Promise<void> {
  await recordOperationalAlert({
    source: 'workers.deploy-error-poll',
    eventKey: operationalEventKey(deployId, title),
    alertname: title.replace(/[^A-Za-z0-9]+/g, ''),
    status: 'firing',
    severity: 'critical',
    payload: {
      deploymentId: deployId,
      summary: title,
      message,
      repository: `${GITHUB_OWNER}/${GITHUB_REPO}`,
      ...diagnostics,
    },
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

export interface VercelDeployment {
  uid: string;
  state: string;
  createdAt: number;
  ready?: number;
  url?: string | null;
  inspectorUrl?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
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
    // newer READY build already superseded (see currentMainFailure).
    //
    // When main returns to READY, record a separate `status: 'resolved'` twin
    // (with `payload.resolves = firing.event_key`) for any open firing
    // VercelDeploymentFailed / AutofixRebuildFailed row superseded by this READY
    // build. That notifies the Reliability Controller that main is READY again
    // without mutating any firing row's `investigation_status` and without
    // touching Vercel.
    const deployments = data.deployments;
    const verdict = currentMainFailure(deployments);
    if (verdict.kind === 'ready') {
      const ready = verdict.deployment;
      const readySha = sanitizeTextField(ready.meta?.githubCommitSha, 64, [vercelToken]) ?? '';
      const readyIndex = deployments.findIndex((d) => d.uid === ready.uid);
      const readyAtMs = typeof ready.ready === 'number' && Number.isFinite(ready.ready) && ready.ready >= ready.createdAt
        ? ready.ready
        : Date.now();
      const readyAtIso = new Date(readyAtMs).toISOString();
      const { resolvedKeys } = await resolveOpenOperationalAlerts({
        source: 'workers.deploy-error-poll',
        alertnames: ['VercelDeploymentFailed', 'AutofixRebuildFailed'],
        shouldResolve: (row) => {
          const failedId = typeof row.payload.deploymentId === 'string' ? row.payload.deploymentId : '';
          if (failedId && failedId === ready.uid) return false;
          if (failedId && readyIndex > 0) {
            const failedIdx = deployments.findIndex((d) => d.uid === failedId);
            if (failedIdx >= 0 && failedIdx < readyIndex) return false;
          }
          return true;
        },
        buildPayload: (row) => ({
          resolved_at: readyAtIso,
          deploymentId: typeof row.payload.deploymentId === 'string' ? row.payload.deploymentId : null,
          successorDeploymentId: ready.uid,
          successorCommitSha: readySha,
          summary: `${row.alertname} cleared: newer main deployment ${ready.uid}${readySha ? ` (${readySha.substring(0, 9)})` : ''} is READY`,
          note: 'Source observation only: main is READY again. Historical failure investigation state is preserved.',
          repository: `${GITHUB_OWNER}/${GITHUB_REPO}`,
        }),
      });
      return c.json({
        action: 'ok',
        message: 'Latest settled main deployment is READY',
        latestSha: readySha ? readySha.substring(0, 9) : undefined,
        resolvedAlerts: resolvedKeys.length,
      });
    }
    if (verdict.kind === 'unsettled') {
      return c.json({ action: 'ok', message: 'No settled main deployment found', checked: verdict.checked });
    }
    const latestFailure = verdict.deployment;
    const deployId = latestFailure.uid;
    const diagnostics = extractDeploymentDiagnostics(latestFailure, [vercelToken]);
    const commitSha = diagnostics.commitSha ?? '';
    const commitMsg = diagnostics.commitMessage ?? '';
    await recordDeployAlert(
      deployId,
      'Vercel Deployment Failed',
      formatDeployFailureMessage(deployId, diagnostics),
      diagnostics,
    );
    // Preserve the existing identity when an old autofix-created build fails.
    // Durable acknowledgement precedes success; no in-memory suppression.
    if (commitMsg.includes('[autofix]')) {
      await recordDeployAlert(
        deployId,
        'Autofix Rebuild Failed',
        `The autofix commit ${commitSha.substring(0, 9)} itself failed (${diagnostics.deploymentState}). Manual intervention may be needed.`,
        diagnostics,
      );
    }
    return c.json({
      action: 'reported',
      deployId,
      deploymentState: diagnostics.deploymentState,
      commitSha,
      releaseAction: 'none',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[deploy-error-poll] Observation failed:', message);
    return c.json({ error: message }, error instanceof OperationalAlertDeliveryError ? 503 : 500);
  }
}
