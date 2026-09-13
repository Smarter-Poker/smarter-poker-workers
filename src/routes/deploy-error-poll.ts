/**
 * GET/POST /cron/deploy-error-poll
 *
 * Ported from pages/api/cron/deploy-error-poll.js (2026-04-24, 681 lines).
 *
 * Every 2 min: polls Vercel for ERROR deployments on hub-vanguard's main
 * branch, triggers the autofix pipeline on hub-vanguard. Cross-dedups with
 * the Hetzner poll.mjs poller via the autofix_attempts Supabase table.
 *
 * This handler is INTENTIONALLY hub-vanguard-specific (TEAM_ID and
 * PROJECT_ID are hardcoded to that project). It stays pointed at the
 * monolith even after cutover.
 *
 * v3 behavior preserved from monolith exactly:
 *   - Stale-build cancellation: preview QUEUED>5min, any BUILDING>15min,
 *     redundant main QUEUED (keep newest)
 *   - SIGKILL/SIGABRT/OOM detection → skipped_unfixable, cpus:1 is the fix
 *   - Circuit breaker: ≥3 autofix commits on same SHA → skip permanently
 *   - Newer-BUILDING-than-ERROR guard: wait for manual fix in flight
 *   - Cross-poller dedup via autofix_attempts
 *   - Attempt escalation: attempt ≥2 gets more aggressive fix hint
 *   - [autofix] loop prevention
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { OperationalAlertDeliveryError, operationalEventKey, recordOperationalAlert } from '../lib/operationalAlerts.js';

const TEAM_ID = 'team_SVD8r7AOPH065G3usBxVvrBc';
const PROJECT_ID = 'prj_op66GkZyZcygXQKm76iyycfVFAQx';
const GITHUB_OWNER = 'Smarter-Poker';
const GITHUB_REPO = 'Smarter-Poker-World-Hub';
const MAX_FIX_ATTEMPTS = 3;

// In-memory dedup — resets on container restart. The Supabase autofix_attempts
// table is the authoritative guard across containers and restarts.
const fixedDeployments = new Set<string>();
const attemptTracker: Record<string, number> = {};

// ── Supabase coordination helpers ──────────────────────────────────────────
async function sbFetch(path: string, options: RequestInit = {}): Promise<Response | null> {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const abort = new AbortController();
  const t = setTimeout(() => abort.abort(), 5000);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(options.headers as Record<string, string> | undefined),
    };
    return await fetch(`${url}${path}`, { ...options, headers, signal: abort.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function isAutofixPaused(): Promise<boolean> {
  try {
    const res = await sbFetch('/rest/v1/rpc/autofix_is_paused', { method: 'POST', body: '{}' });
    if (!res?.ok) return false;
    return (await res.json()) as boolean;
  } catch {
    return false;
  }
}

async function alreadyAttemptedInSupa(commitSha: string): Promise<boolean> {
  try {
    const res = await sbFetch(
      `/rest/v1/autofix_attempts?select=id&commit_sha=eq.${encodeURIComponent(commitSha)}&status=in.(running,pr_opened,merged,skipped_unfixable)`,
      { method: 'GET' },
    );
    if (!res?.ok) return false;
    const rows = (await res.json()) as Array<{ id: string }>;
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

interface RecordAttemptArgs {
  deployId: string;
  commitSha: string;
  strategy?: string;
  confidence?: string;
  status: string;
  metadata?: Record<string, unknown>;
}

async function recordAttempt(args: RecordAttemptArgs): Promise<string | null> {
  try {
    const id = randomUUID();
    await sbFetch('/rest/v1/autofix_attempts', {
      method: 'POST',
      headers: { Prefer: 'return=representation', Accept: 'application/json' },
      body: JSON.stringify({
        id,
        source: 'vercel_openclaw',
        deployment_id: args.deployId,
        commit_sha: args.commitSha,
        repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
        strategy: args.strategy ?? 'generic',
        confidence: args.confidence ?? 'medium',
        status: args.status,
        metadata: args.metadata ?? {},
      }),
    });
    return id;
  } catch (e) {
    console.warn('[deploy-error-poll] recordAttempt failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

async function updateAttemptStatus(id: string | null, status: string): Promise<void> {
  if (!id) return;
  try {
    await sbFetch(`/rest/v1/autofix_attempts?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status }),
    });
  } catch (e) {
    console.warn('[deploy-error-poll] updateAttemptStatus failed:', e instanceof Error ? e.message : e);
  }
}

// ── Notifications ──────────────────────────────────────────────────────────
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

interface NotifyField {
  title: string;
  value: string;
  short?: boolean;
}

async function sendNotification(args: {
  title: string;
  message: string;
  color: 'good' | 'warning' | 'danger';
  fields?: NotifyField[];
}): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL ?? process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    if (webhookUrl.includes('discord.com')) {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [
            {
              title: args.title,
              description: args.message,
              color: args.color === 'good' ? 0x00ff00 : args.color === 'danger' ? 0xff0000 : 0xffaa00,
              fields: args.fields?.map((f) => ({ name: f.title, value: f.value, inline: true })) ?? [],
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      });
    } else {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attachments: [
            {
              color: args.color,
              title: args.title,
              text: args.message,
              fields: args.fields ?? [],
              ts: Math.floor(Date.now() / 1000),
            },
          ],
        }),
      });
    }
  } catch (e) {
    console.warn('[deploy-error-poll] notification failed:', e instanceof Error ? e.message : e);
  }
}

function extractBrokenFiles(buildErrors: string): string[] {
  const files = new Set<string>();
  const moduleNotFound = buildErrors.match(/\.\/(pages|src|lib|components|utils|hooks|styles|services|data)\/[\w./\-[\]]+\.(jsx?|tsx?|mjs|cjs)/g);
  if (moduleNotFound) moduleNotFound.forEach((f) => files.add(f.replace('./', '')));
  const tsErrors = buildErrors.match(/(pages|src|lib|components|utils|hooks|services|data)\/[^\s(:]+\.(tsx?|jsx?)/g);
  if (tsErrors) tsErrors.forEach((f) => files.add(f));
  return [...files];
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
  const vercelToken = process.env.VERCEL_TOKEN;
  const internalSecret = process.env.DEPLOY_INTERNAL_SECRET;
  const ghPat = process.env.GH_PAT;

  if (!vercelToken) {
    return c.json({ action: 'skipped', message: 'VERCEL_TOKEN not configured — deploy-error-poll disabled on this host' });
  }

  // Kill-switch
  if (await isAutofixPaused()) {
    console.warn('[deploy-error-poll] Autofix globally paused — exiting');
    return c.json({ action: 'paused', message: 'Autofix is globally paused via kill-switch' });
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
    } finally {
      clearTimeout(step1Timeout);
    }

    if (!deploymentsRes.ok) {
      const errText = await deploymentsRes.text();
      await recordOperationalAlert({
        source: 'workers.deploy-error-poll',
        eventKey: operationalEventKey('vercel-api', deploymentsRes.status, Math.floor(Date.now() / 3_600_000)),
        alertname: 'DeploymentMonitorUnavailable',
        status: 'firing',
        severity: 'critical',
        payload: { summary: `Deployment monitoring cannot read Vercel (HTTP ${deploymentsRes.status})`, details: errText.substring(0, 200), projectId: PROJECT_ID },
      });
      return c.json(
        { error: `Vercel API error: ${deploymentsRes.status}`, details: errText.substring(0, 200) },
        500,
      );
    }

    const data = (await deploymentsRes.json()) as { deployments?: VercelDeployment[] };
    const allDeployments = data.deployments ?? [];
    const nowMs = Date.now();

    // Step 1b: cancel stale / hung / redundant builds
    const stalePreviewQueued = allDeployments.filter((d) => {
      const branch = d.meta?.githubCommitRef ?? '';
      return d.state === 'QUEUED' && branch !== 'main' && nowMs - d.createdAt > 5 * 60 * 1000;
    });
    const hungBuilds = allDeployments.filter(
      (d) => d.state === 'BUILDING' && nowMs - d.createdAt > 15 * 60 * 1000,
    );
    const mainQueued = allDeployments
      .filter((d) => d.state === 'QUEUED' && (d.meta?.githubCommitRef ?? '') === 'main')
      .sort((a, b) => b.createdAt - a.createdAt);
    const redundantMainQueued = mainQueued.slice(1);

    const buildsToCancel = [...stalePreviewQueued, ...hungBuilds, ...redundantMainQueued];
    const uniqueToCancel = [...new Map(buildsToCancel.map((d) => [d.uid, d])).values()];
    const canceledUids = new Set<string>();

    await Promise.all(
      uniqueToCancel.map(async (stale) => {
        try {
          await fetch(
            `https://api.vercel.com/v12/deployments/${stale.uid}/cancel?teamId=${TEAM_ID}`,
            { method: 'PATCH', headers: { Authorization: `Bearer ${vercelToken}` } },
          );
          canceledUids.add(stale.uid);
          const reason =
            stale.state === 'BUILDING'
              ? 'Hung >15m'
              : stale.meta?.githubCommitRef === 'main'
                ? 'Redundant Queue'
                : 'Preview >5m';
          console.warn(`[deploy-error-poll] Cancelled ${stale.state} build ${stale.uid} (${reason})`);
        } catch (e) {
          console.warn(`[deploy-error-poll] Failed to cancel ${stale.uid}: ${e instanceof Error ? e.message : e}`);
        }
      }),
    );

    // Filter to main branch only
    const deployments = allDeployments.filter((d) => (d.meta?.githubCommitRef ?? '') === 'main');
    if (deployments.length === 0) {
      return c.json({
        action: 'ok',
        message: 'No main branch deployments in recent history',
        checked: allDeployments.length,
      });
    }

    // Step 2: short-circuit if latest actionable deploy is READY
    const latestActionable = deployments.find(
      (d) => d.state === 'READY' || d.state === 'ERROR' || d.state === 'BUILDING',
    );
    if (latestActionable && latestActionable.state === 'READY') {
      const latestMsg = latestActionable.meta?.githubCommitMessage ?? '';
      if (latestMsg.includes('[autofix]')) {
        sendNotification({
          title: '✅ Autofix Rebuild Succeeded',
          message: `\`${latestActionable.meta?.githubCommitSha?.substring(0, 9) ?? ''}\` is READY — autofix resolved the build error.`,
          color: 'good',
          fields: [
            { title: 'File', value: latestMsg.match(/in (.+?) \(/)?.[1] ?? 'unknown', short: true },
            { title: 'SHA', value: latestActionable.meta?.githubCommitSha?.substring(0, 9) ?? '', short: true },
          ],
        }).catch(() => undefined);
      }
      return c.json({
        action: 'ok',
        message: 'Latest actionable deploy is READY — no action needed',
        latestSha: latestActionable.meta?.githubCommitSha?.substring(0, 9),
      });
    }

    // Step 3: find latest ERROR
    const latestError = deployments.find((d) => d.state === 'ERROR');
    if (!latestError) {
      return c.json({ action: 'ok', message: 'No ERROR deployments found', checked: deployments.length });
    }

    const deployId = latestError.uid;
    const commitSha = latestError.meta?.githubCommitSha ?? '';
    const commitMsg = latestError.meta?.githubCommitMessage ?? '';

    // Record the failure before any dedup/circuit breaker or autofix side effect.
    // Retries share the deployment identity, including after a process restart.
    await recordDeployAlert(deployId, 'Vercel Deployment Failed',
      `Deployment ${deployId} failed for commit ${commitSha}. ${commitMsg}`);

    if (fixedDeployments.has(deployId)) {
      return c.json({ action: 'skipped', deployId, reason: 'already fixed (in-memory)' });
    }

    // Skip [autofix] commits — prevent loops
    if (commitMsg.includes('[autofix]')) {
      sendNotification({
        title: '⚠️ Autofix Rebuild Failed',
        message: `The autofix commit \`${commitSha.substring(0, 9)}\` itself failed to build. Manual intervention may be needed.`,
        color: 'danger',
        fields: [
          { title: 'Deploy', value: deployId.substring(0, 12), short: true },
          { title: 'SHA', value: commitSha.substring(0, 9), short: true },
        ],
      }).catch(() => undefined);
      await recordDeployAlert(deployId,
        'Autofix Rebuild Failed',
        `The autofix commit ${commitSha.substring(0, 9)} itself failed to build. Manual intervention may be needed.`,
      );
      fixedDeployments.add(deployId);
      return c.json({ action: 'skipped', deployId, reason: 'is an [autofix] commit — skipping to prevent loops' });
    }

    // Circuit breaker via git history
    if (!attemptTracker[commitSha]) {
      attemptTracker[commitSha] = 1;
      const keys = Object.keys(attemptTracker);
      if (keys.length > 50) {
        const first = keys[0];
        if (first) delete attemptTracker[first];
      }
    }
    if (ghPat && commitSha) {
      try {
        const cbAbort = new AbortController();
        const cbTimeout = setTimeout(() => cbAbort.abort(), 10000);
        let commitsRes: Response;
        try {
          commitsRes = await fetch(
            `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits?sha=main&per_page=20`,
            {
              headers: { Authorization: `Bearer ${ghPat}`, Accept: 'application/vnd.github.v3+json' },
              signal: cbAbort.signal,
            },
          );
        } finally {
          clearTimeout(cbTimeout);
        }
        if (commitsRes.ok) {
          const commits = (await commitsRes.json()) as Array<{ commit?: { message?: string } }>;
          const autofixCount = commits.filter(
            (x) => x.commit?.message?.includes('[autofix]') && x.commit?.message?.includes(commitSha.substring(0, 9)),
          ).length;
          if (autofixCount >= MAX_FIX_ATTEMPTS) {
            recordAttempt({
              deployId,
              commitSha,
              strategy: 'generic',
              confidence: 'low',
              status: 'skipped_unfixable',
              metadata: { reason: 'circuit_breaker', attempts: autofixCount },
            }).catch(() => undefined);
            sendNotification({
              title: '🛑 Autofix Circuit Breaker',
              message: `Reached ${MAX_FIX_ATTEMPTS} fix attempts for \`${commitSha.substring(0, 9)}\`. Stopping. Manual fix required.`,
              color: 'danger',
              fields: [{ title: 'Attempts', value: String(autofixCount), short: true }],
            }).catch(() => undefined);
            await recordDeployAlert(deployId,
              'Autofix Circuit Breaker',
              `Reached ${MAX_FIX_ATTEMPTS} fix attempts for ${commitSha.substring(0, 9)}. Stopping. Manual fix required.`,
            );
            fixedDeployments.add(deployId);
            return c.json({
              action: 'circuit_breaker',
              deployId,
              commitSha: commitSha.substring(0, 8),
              attempts: autofixCount,
            });
          }
          attemptTracker[commitSha] = autofixCount + 1;
        }
      } catch (e) {
        if (e instanceof OperationalAlertDeliveryError) throw e;
        console.warn(`[deploy-error-poll] Git history check failed: ${e instanceof Error ? e.message : e}`);
      }
    }

    // Step 3b: newer BUILDING guard
    const newerBuilding = deployments.find(
      (d) => d.state === 'BUILDING' && d.createdAt > latestError.createdAt && !canceledUids.has(d.uid),
    );
    if (newerBuilding) {
      return c.json({
        action: 'ok',
        message: 'Newer BUILDING deploy in progress — waiting before autofix to avoid conflict',
        buildingSha: newerBuilding.meta?.githubCommitSha?.substring(0, 9),
        errorSha: commitSha.substring(0, 9),
      });
    }

    // Step 4: fetch build logs
    console.warn(`[deploy-error-poll] Processing ERROR deployment ${deployId} (${commitSha.substring(0, 8)})`);
    let buildErrors = '';
    const logFailKey = `logfail:${deployId}`;
    try {
      const logAbort = new AbortController();
      const logTimeout = setTimeout(() => logAbort.abort(), 20000);
      let logsRes: Response;
      try {
        logsRes = await fetch(
          `https://api.vercel.com/v2/deployments/${deployId}/events?teamId=${TEAM_ID}&direction=backward&limit=500`,
          { headers: { Authorization: `Bearer ${vercelToken}` }, signal: logAbort.signal },
        );
      } finally {
        clearTimeout(logTimeout);
      }
      if (logsRes.ok) {
        const events = (await logsRes.json()) as Array<{ payload?: { text?: string }; text?: string }>;
        if (Array.isArray(events)) {
          const allLines = events.map((e) => e.payload?.text ?? e.text ?? '').filter(Boolean);

          // SIGKILL / SIGABRT / OOM detection
          const isSigkill = allLines.some(
            (l) =>
              l.includes('SIGKILL') ||
              l.includes('SIGABRT') ||
              l.includes('out of memory') ||
              l.includes('Ineffective mark-compacts near heap limit') ||
              l.includes('JavaScript heap out of memory') ||
              l.includes('Allocation failed') ||
              /\bOOM\b/.test(l),
          );
          if (isSigkill) {
            console.warn(`[deploy-error-poll] SIGKILL/SIGABRT/OOM detected for ${deployId}`);
            recordAttempt({
              deployId,
              commitSha,
              strategy: 'oom',
              confidence: 'high',
              status: 'skipped_unfixable',
              metadata: { reason: 'SIGKILL_SIGABRT_OOM_detected_by_openclaw' },
            }).catch(() => undefined);
            sendNotification({
              title: '💥 Build OOM/SIGABRT',
              message: `Deploy \`${commitSha.substring(0, 9)}\` killed by OOM signal (infrastructure issue). DO NOT bump heap — cpus:1 is the fix.`,
              color: 'danger',
              fields: [{ title: 'SHA', value: commitSha.substring(0, 9), short: true }],
            }).catch(() => undefined);
            await recordDeployAlert(deployId,
              'Build OOM/SIGABRT',
              `Deploy ${commitSha.substring(0, 9)} killed by OOM. Infrastructure issue — NOT fixable by bumping heap. cpus:1 is the fix.`,
            );
            fixedDeployments.add(deployId);
            return c.json({
              action: 'skipped',
              deployId,
              commitSha: commitSha.substring(0, 8),
              reason: 'SIGKILL/SIGABRT/OOM — infrastructure error. NOT fixable by heap bump. cpus:1 in next.config is the correct fix.',
            });
          }

          // Extract errors with ±3 lines context
          const errorKeywords = [
            'Module not found', 'Cannot find', 'SyntaxError', 'Type error', 'TypeError',
            'Failed to compile', 'Build failed', 'error TS', 'Unexpected token',
            'ReferenceError', 'is not a module', 'does not provide an export',
            'Cannot read properties', 'exited with',
            'TS2304', 'TS2305', 'TS2307', 'TS2345', 'TS2322', 'TS2339', 'TS2551',
            'TS7006', 'TS2554', 'TS1005', 'TS1128', 'TS2741',
            'does not exist on type',
          ];
          const srcDirRegex = /\.\/(?:pages|src|lib|components|services|data|utils|hooks|styles)\//;
          const includedIndices = new Set<number>();
          allLines.forEach((line, idx) => {
            if (errorKeywords.some((kw) => line.includes(kw)) || srcDirRegex.test(line)) {
              for (let j = Math.max(0, idx - 3); j <= Math.min(allLines.length - 1, idx + 3); j++) {
                includedIndices.add(j);
              }
            }
          });
          const contextLines = [...includedIndices]
            .sort((a, b) => a - b)
            .map((i) => allLines[i] ?? '');
          buildErrors = contextLines.join('\n');
        }
      }
    } catch (e) {
      if (e instanceof OperationalAlertDeliveryError) throw e;
      console.warn(`[deploy-error-poll] Log fetch failed for ${deployId}: ${e instanceof Error ? e.message : e}`);
      attemptTracker[logFailKey] = (attemptTracker[logFailKey] ?? 0) + 1;
      if ((attemptTracker[logFailKey] ?? 0) >= 3) {
        fixedDeployments.add(deployId);
        console.warn(`[deploy-error-poll] Log fetch failed 3 times for ${deployId} — deduped`);
      }
    }

    if (!buildErrors) {
      return c.json({ action: 'skipped', deployId, reason: 'could not extract build errors from logs (will retry)' });
    }

    // Step 5: extract broken files + fire autofix
    const brokenFiles = extractBrokenFiles(buildErrors);
    const attempt = attemptTracker[commitSha] ?? 1;

    console.warn(`[deploy-error-poll] Found ${brokenFiles.length} broken file(s): ${brokenFiles.join(', ')}`);
    console.warn(`[deploy-error-poll] Attempt ${attempt}/${MAX_FIX_ATTEMPTS} for ${commitSha.substring(0, 8)}`);

    if (await alreadyAttemptedInSupa(commitSha)) {
      console.warn(`[deploy-error-poll] ${commitSha.substring(0, 8)} already handled by another poller — skipping`);
      fixedDeployments.add(deployId);
      return c.json({
        action: 'skipped',
        deployId,
        reason: 'already handled by another autofix poller (Supabase dedup)',
      });
    }

    const attemptId = await recordAttempt({
      deployId,
      commitSha,
      strategy: 'generic',
      confidence: brokenFiles.length > 0 ? 'medium' : 'low',
      status: 'running',
      metadata: { brokenFiles, attempt },
    });

    try {
      const autofixPayload = {
        commitSha,
        deploymentId: deployId,
        buildErrors,
        attempt,
        brokenFiles: brokenFiles.length > 0 ? brokenFiles : undefined,
        escalation:
          attempt >= 2
            ? {
                level: attempt,
                hint: 'Previous fix attempt failed. Try a different approach: check if the import target was renamed/moved, or if the file should be deleted entirely.',
              }
            : undefined,
      };

      const pollAbort = new AbortController();
      const pollTimeout = setTimeout(() => pollAbort.abort(), 55000);
      let autofixRes: Response;
      try {
        autofixRes = await fetch('https://smarter.poker/api/deploy-autofix', {
          method: 'POST',
          signal: pollAbort.signal,
          headers: {
            'Content-Type': 'application/json',
            ...(internalSecret ? { 'x-internal-secret': internalSecret } : {}),
          },
          body: JSON.stringify(autofixPayload),
        });
      } finally {
        clearTimeout(pollTimeout);
      }

      let autofixResult: { action?: string; filePath?: string; file?: string; newCommitSha?: string; prNumber?: number; prUrl?: string } = {};
      try {
        autofixResult = (await autofixRes.json()) as typeof autofixResult;
      } catch {
        autofixResult = { action: 'parse_error' };
      }

      if (autofixResult.action === 'fixed') {
        fixedDeployments.add(deployId);
        console.warn(`[deploy-error-poll] ✅ Fix pushed for ${deployId}`);
        sendNotification({
          title: '🔧 Autofix Deployed',
          message: `Claude fixed \`${autofixResult.filePath ?? autofixResult.file ?? 'unknown'}\` and pushed to main. Rebuild starting.`,
          color: 'warning',
          fields: [
            { title: 'File(s)', value: autofixResult.filePath ?? autofixResult.file ?? 'unknown', short: true },
            { title: 'Attempt', value: `${attempt}/${MAX_FIX_ATTEMPTS}`, short: true },
            {
              title: 'SHA',
              value: autofixResult.newCommitSha?.substring(0, 9) ?? commitSha.substring(0, 9),
              short: true,
            },
          ],
        }).catch(() => undefined);
      } else if (autofixResult.action === 'pr_opened') {
        sendNotification({
          title: '📋 Autofix PR Opened',
          message: `Fix for \`${autofixResult.filePath ?? 'unknown'}\` staged in PR #${autofixResult.prNumber}. Review and merge to unblock deploy.`,
          color: 'warning',
          fields: [
            { title: 'PR', value: autofixResult.prUrl ?? 'unknown', short: true },
            { title: 'Attempt', value: `${attempt}/${MAX_FIX_ATTEMPTS}`, short: true },
          ],
        }).catch(() => undefined);
        await recordDeployAlert(deployId,
          'Autofix PR Opened',
          `Fix for ${autofixResult.filePath ?? 'unknown'} staged in PR #${autofixResult.prNumber}. Review and merge to unblock deploy.`,
        );
      } else if (autofixResult.action === 'skipped') {
        const skipKey = `skip:${deployId}`;
        attemptTracker[skipKey] = (attemptTracker[skipKey] ?? 0) + 1;
        if ((attemptTracker[skipKey] ?? 0) >= 2) {
          fixedDeployments.add(deployId);
          console.warn(`[deploy-error-poll] Deduped unfixable deploy ${deployId} after ${attemptTracker[skipKey]} skips`);
        }
        updateAttemptStatus(attemptId, 'failed').catch(() => undefined);
      } else {
        console.warn(`[deploy-error-poll] Autofix returned: ${autofixResult.action} — will retry`);
        updateAttemptStatus(attemptId, 'failed').catch(() => undefined);
      }

      return c.json({
        action: 'processed',
        deployId,
        commitSha: commitSha.substring(0, 8),
        attempt,
        brokenFiles,
        autofixResult,
      });
    } catch (e) {
      if (e instanceof OperationalAlertDeliveryError) throw e;
      if (e instanceof Error && e.name === 'AbortError') {
        console.warn(`[deploy-error-poll] Autofix call timed out after 55s for ${deployId}`);
        return c.json({ action: 'autofix_timeout', deployId, error: 'deploy-autofix fetch timed out' });
      }
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[deploy-error-poll] Autofix call failed: ${msg}`);
      return c.json({ action: 'autofix_call_failed', deployId, error: msg });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[deploy-error-poll] Fatal error: ${msg}`);
    return c.json({ error: msg }, e instanceof OperationalAlertDeliveryError ? 503 : 500);
  }
}
