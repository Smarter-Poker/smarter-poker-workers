import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { deployErrorPoll } from '../routes/deploy-error-poll.js';
import { scraperWatchdog } from '../routes/scraper-watchdog.js';
import { videoLibraryScraper } from '../routes/video-library-scraper.js';
import { recordDeploymentMonitorHealth } from './deploymentMonitorHealth.js';
import { evaluateAndAlert } from './scraperAlerts.js';
import {
  OperationalAlertDeliveryError,
  operationalEventKey,
  recordOperationalAlert,
  resolvedTwinEventKey,
} from './operationalAlerts.js';
import { resolveOpenOperationalAlerts } from './operationalAlertResolution.js';

/**
 * EVERY OPERATIONAL ALERT PRODUCER RESOLVES ITS OWN FIRING MEMBERS (2026-11-25)
 *
 * Incident 86bcafc1-80ae-4118-afff-7fa2aa505386 (VercelDeploymentFailed, class release):
 *   1. World Hub main broke on db0bd6aa (#3010) and 98842721 (#3009), firing inbox
 *      rows 449069 and 449081. PR #3011 (aca9e106) fixed the build and deployed READY.
 *   2. `deploy-error-poll` never emitted `status: 'resolved'` twins when main returned
 *      to READY, leaving the Reliability Controller incident permanently `escalated`
 *      (exact recurrence of incidents 9d726490 on 2026-11-10 and 068e7ad9 on 2026-11-16).
 *   3. Sibling audit found the same resolution-contract defect across the service:
 *      - `deploymentMonitorHealth.ts` omitted `payload.resolves` on recovery, causing
 *        `smarter_private.reliability_ingest_alert` to compute a mismatched `v_member`
 *        and reject the recovery as `resolved_not_of_this_episode`.
 *      - `scraper-watchdog.ts` omitted `payload.resolves` on recovery and lost earlier
 *        firing keys across cooldown re-fires or stale->dead escalations.
 *      - `video-library-scraper.ts` and `scraperAlerts.ts` fired alerts with no resolve
 *        twin when subsequent clean runs succeeded.
 *      - `operationalAlerts.ts` did not reject a `resolved` event reusing the firing
 *        `eventKey` (which `fn_record_operational_alert`'s `ON CONFLICT DO UPDATE`
 *        silently drops because it only updates `last_received_at` and `delivery_count`).
 */

type InboxRow = {
  source: string;
  event_key: string;
  alertname: string;
  status: string;
  severity?: string;
  payload: Record<string, unknown>;
  received_at: string;
  last_received_at: string;
};

const state = vi.hoisted(() => ({
  inbox: [] as InboxRow[],
  watchdogState: new Map<string, string>(),
  auditRows: new Map<string, Record<string, unknown>>(),
  freshScraper: false,
  minutesOld: 90,
  inboxReadError: null as null | { message: string },
  rpcError: null as null | { message: string },
  rpcCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('./supabase.js', () => ({
  getSupabase: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'fn_record_operational_alert') {
        state.rpcCalls.push(args);
        if (state.rpcError) return { data: null, error: state.rpcError };
        const now = new Date().toISOString();
        const existing = state.inbox.find(
          (r) => r.source === args.p_source && r.event_key === args.p_event_key,
        );
        if (existing) {
          existing.last_received_at = now;
        } else {
          state.inbox.unshift({
            source: String(args.p_source),
            event_key: String(args.p_event_key),
            alertname: String(args.p_alertname),
            status: String(args.p_status),
            severity: String(args.p_severity),
            payload: (args.p_payload ?? {}) as Record<string, unknown>,
            received_at: now,
            last_received_at: now,
          });
        }
        return { data: state.inbox.length + 100, error: null };
      }
      return { data: null, error: null };
    },
    from: (table: string) => {
      const filters: Array<{ field: string; value: unknown }> = [];
      let pendingInsert: Record<string, unknown> | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        insert: (row: Record<string, unknown>) => {
          pendingInsert = row;
          return chain;
        },
        eq: (field: string, value: unknown) => {
          filters.push({ field, value });
          return chain;
        },
        order: () => chain,
        limit: async (n: number) => {
          if (table === 'operational_alert_events') {
            if (state.inboxReadError) return { data: null, error: state.inboxReadError };
            const rows = state.inbox.filter((row) =>
              filters.every((f) => (row as Record<string, unknown>)[f.field] === f.value),
            );
            return { data: rows.slice(0, n), error: null };
          }
          if (table === 'venue_live_tables') {
            const ageMs = (state.freshScraper ? 0 : state.minutesOld) * 60_000;
            return {
              data: [{ scrape_timestamp: new Date(Date.now() - ageMs).toISOString() }],
              count: 500,
              error: null,
            };
          }
          return { data: [], error: null };
        },
        maybeSingle: async () => {
          if (table === 'scraper_watchdog_state') {
            const key = String(filters.find((f) => f.field === 'key')?.value ?? '');
            const val = state.watchdogState.get(key);
            return { data: val ? { value: val } : null, error: null };
          }
          if (table === 'data_audit_log' && pendingInsert) {
            const id = String(pendingInsert.id);
            state.auditRows.set(id, structuredClone(pendingInsert));
            return { data: { id }, error: null };
          }
          return { data: null, error: null };
        },
        upsert: async (row: { key: string; value: string }) => {
          if (table === 'scraper_watchdog_state') {
            state.watchdogState.set(row.key, row.value);
          }
          return { data: null, error: null };
        },
      };
      return chain;
    },
  }),
}));

beforeEach(() => {
  state.inbox.length = 0;
  state.watchdogState.clear();
  state.auditRows.clear();
  state.freshScraper = false;
  state.minutesOld = 90;
  state.inboxReadError = null;
  state.rpcError = null;
  state.rpcCalls.length = 0;
  vi.stubEnv('VERCEL_TOKEN', 'test-vercel-token');
  vi.stubEnv('NODE_ENV', 'test');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('reliability controller twin-event resolution law', () => {
  it('declares a resolve path for every firing operational alert producer in src/', () => {
    const srcRoot = fileURLToPath(new URL('..', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) files.push(full);
      }
    };
    walk(srcRoot);

    const declaredFiringProducers: Record<string, string> = {
      'lib/deploymentMonitorHealth.ts': 'resolves via payload.resolves on healthy Vercel read',
      'lib/scraperAlerts.ts': 'resolves via resolveOpenOperationalAlerts on clean evaluateAndAlert run',
      'routes/deploy-error-poll.ts': 'resolves via resolveOpenOperationalAlerts when main returns to READY',
      'routes/scraper-watchdog.ts': 'resolves tracked firing keys with payload.resolves on recovery',
      'routes/video-library-scraper.ts': 'resolves via resolveOpenOperationalAlerts on clean full scrape',
    };

    const actualFiringFiles: string[] = [];
    for (const file of files) {
      const rel = relative(srcRoot, file);
      if (rel === 'lib/operationalAlerts.ts' || rel === 'lib/operationalAlertResolution.ts') continue;
      const content = readFileSync(file, 'utf8');
      if (content.includes('recordOperationalAlert') && /status\s*:\s*['"]firing['"]|status\s*:\s*['"]firing['"]\s*\|\s*['"]resolved['"]/.test(content)) {
        actualFiringFiles.push(rel);
      }
    }

    expect(actualFiringFiles.sort()).toEqual(Object.keys(declaredFiringProducers).sort());

    // Every declared producer must reference either resolveOpenOperationalAlerts or payload `resolves:`
    for (const rel of Object.keys(declaredFiringProducers)) {
      const content = readFileSync(join(srcRoot, rel), 'utf8');
      const hasResolver = content.includes('resolveOpenOperationalAlerts') || /\bresolves\s*:/.test(content);
      expect(hasResolver, `${rel} fires operational alerts without a twin-event resolver`).toBe(true);
    }
  });

  it('refuses a resolved alert that reuses the firing eventKey or supplies malformed payload.resolves', async () => {
    await expect(
      recordOperationalAlert({
        source: 'workers.deploy-error-poll',
        eventKey: 'same-key',
        alertname: 'VercelDeploymentFailed',
        status: 'resolved',
        severity: 'info',
        payload: { resolves: 'same-key', summary: 'broken self-collision' },
      }),
    ).rejects.toBeInstanceOf(OperationalAlertDeliveryError);

    await expect(
      recordOperationalAlert({
        source: 'workers.deploy-error-poll',
        eventKey: 'k:resolved',
        alertname: 'VercelDeploymentFailed',
        status: 'resolved',
        severity: 'info',
        payload: { resolves: '   ', summary: 'blank resolves' },
      }),
    ).rejects.toBeInstanceOf(OperationalAlertDeliveryError);

    expect(state.rpcCalls).toHaveLength(0);
  });

  it('deploy-error-poll resolves both firing VercelDeploymentFailed rows (449069 + 449081 shape) when main returns to READY, and is idempotent on repeat polls', async () => {
    const k1 = operationalEventKey('dpl_db0bd6aa', 'Vercel Deployment Failed');
    const k2 = operationalEventKey('dpl_98842721', 'Vercel Deployment Failed');
    const now = Date.now();
    state.inbox.push(
      {
        source: 'workers.deploy-error-poll',
        event_key: k2,
        alertname: 'VercelDeploymentFailed',
        status: 'firing',
        payload: { deploymentId: 'dpl_98842721', summary: 'Vercel Deployment Failed' },
        received_at: new Date(now - 20 * 60_000).toISOString(),
        last_received_at: new Date(now - 10 * 60_000).toISOString(),
      },
      {
        source: 'workers.deploy-error-poll',
        event_key: k1,
        alertname: 'VercelDeploymentFailed',
        status: 'firing',
        payload: { deploymentId: 'dpl_db0bd6aa', summary: 'Vercel Deployment Failed' },
        received_at: new Date(now - 30 * 60_000).toISOString(),
        last_received_at: new Date(now - 22 * 60_000).toISOString(),
      },
    );

    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET') return new Response('{}', { status: 405 });
      return new Response(
        JSON.stringify({
          deployments: [
            {
              uid: 'dpl_aca9e106',
              state: 'READY',
              createdAt: now - 15 * 60_000,
              ready: now - 10 * 60_000,
              meta: { githubCommitRef: 'main', githubCommitSha: 'aca9e1063f944cdc484f' },
            },
            {
              uid: 'dpl_98842721',
              state: 'ERROR',
              createdAt: now - 22 * 60_000,
              meta: { githubCommitRef: 'main', githubCommitSha: '9884272147cfc70fa0e5' },
            },
            {
              uid: 'dpl_db0bd6aa',
              state: 'ERROR',
              createdAt: now - 35 * 60_000,
              meta: { githubCommitRef: 'main', githubCommitSha: 'db0bd6aad772c932bf9e' },
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = new Hono();
    app.get('/cron/deploy-error-poll', deployErrorPoll);

    const first = await app.request('/cron/deploy-error-poll');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ action: 'ok', latestSha: 'aca9e1063', resolvedAlerts: 2 });

    const resolvedCalls = state.rpcCalls.filter((c) => c.p_status === 'resolved');
    expect(resolvedCalls).toHaveLength(2);
    for (const key of [k1, k2]) {
      const match = resolvedCalls.find((c) => (c.p_payload as Record<string, unknown>).resolves === key);
      expect(match, `missing resolved twin for firing key ${key}`).toBeDefined();
      expect(match!.p_event_key).toBe(`${key}:resolved`);
      expect(match!.p_alertname).toBe('VercelDeploymentFailed');
      expect(match!.p_severity).toBe('info');
      expect((match!.p_payload as Record<string, unknown>).successorDeploymentId).toBe('dpl_aca9e106');
    }

    // Second poll must emit ZERO additional resolved writes.
    const callsAfterFirst = state.rpcCalls.length;
    const second = await app.request('/cron/deploy-error-poll');
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ action: 'ok', resolvedAlerts: 0 });
    expect(state.rpcCalls.length).toBe(callsAfterFirst);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('deploy-error-poll fires for a BLOCKED main deployment, resolves it cleanly when a newer READY supersedes it, and stays idempotent', async () => {
    const now = Date.now();
    const blockedId = 'dpl_blocked_main_42';
    const readyId = 'dpl_ready_main_43';
    const expectedFiringKey = operationalEventKey(blockedId, 'Vercel Deployment Failed');
    let phase: 'blocked' | 'ready' | 'ready_with_queued' = 'blocked';

    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET') return new Response('{}', { status: 405 });
      if (phase === 'blocked') {
        return new Response(JSON.stringify({
          deployments: [
            {
              uid: blockedId,
              state: 'BLOCKED',
              createdAt: now - 120_000,
              inspectorUrl: `https://vercel.com/smarter-poker/hub-vanguard/${blockedId}`,
              errorCode: 'DEPLOYMENT_BLOCKED',
              errorMessage: 'Blocked due to deployment protection check',
              meta: {
                githubCommitRef: 'main',
                githubCommitSha: '1111aaaa2222bbbb',
                githubCommitMessage: 'chore: blocked deploy',
              },
            },
            {
              uid: 'dpl_old_ready',
              state: 'READY',
              createdAt: now - 300_000,
              meta: { githubCommitRef: 'main', githubCommitSha: '0000oldready' },
            },
          ],
        }), { status: 200 });
      }
      const deployments = [
        ...(phase === 'ready_with_queued'
          ? [{ uid: 'dpl_queued_next', state: 'QUEUED', createdAt: now, meta: { githubCommitRef: 'main' } }]
          : []),
        {
          uid: readyId,
          state: 'READY',
          createdAt: now - 60_000,
          ready: now - 30_000,
          meta: { githubCommitRef: 'main', githubCommitSha: '9999cccc8888dddd' },
        },
        {
          uid: blockedId,
          state: 'BLOCKED',
          createdAt: now - 120_000,
          meta: { githubCommitRef: 'main', githubCommitSha: '1111aaaa2222bbbb' },
        },
      ];
      return new Response(JSON.stringify({ deployments }), { status: 200 });
    }));

    const app = new Hono();
    app.get('/cron/deploy-error-poll', deployErrorPoll);

    // 1. Poll observes BLOCKED main deploy -> fires VercelDeploymentFailed with diagnostics.
    const fireRes = await app.request('/cron/deploy-error-poll');
    expect(fireRes.status).toBe(200);
    expect(await fireRes.json()).toMatchObject({
      action: 'reported',
      deployId: blockedId,
      deploymentState: 'BLOCKED',
      releaseAction: 'none',
    });
    const firingCalls = state.rpcCalls.filter((c) => c.p_alertname === 'VercelDeploymentFailed' && c.p_status === 'firing');
    expect(firingCalls).toHaveLength(1);
    expect(firingCalls[0]).toMatchObject({
      p_source: 'workers.deploy-error-poll',
      p_event_key: expectedFiringKey,
      p_alertname: 'VercelDeploymentFailed',
      p_status: 'firing',
      p_payload: {
        deploymentId: blockedId,
        deploymentState: 'BLOCKED',
        errorCode: 'DEPLOYMENT_BLOCKED',
        errorMessage: 'Blocked due to deployment protection check',
        inspectorUrl: `https://vercel.com/smarter-poker/hub-vanguard/${blockedId}`,
        commitSha: '1111aaaa2222bbbb',
        commitMessage: 'chore: blocked deploy',
      },
    });

    // 2. Newer READY deploy supersedes BLOCKED -> emits single resolved twin with payload.resolves.
    phase = 'ready';
    const resolveRes = await app.request('/cron/deploy-error-poll');
    expect(resolveRes.status).toBe(200);
    expect(await resolveRes.json()).toMatchObject({ action: 'ok', latestSha: '9999cccc8', resolvedAlerts: 1 });
    const resolvedCalls = state.rpcCalls.filter((c) => c.p_alertname === 'VercelDeploymentFailed' && c.p_status === 'resolved');
    expect(resolvedCalls).toHaveLength(1);
    expect(resolvedCalls[0]).toMatchObject({
      p_source: 'workers.deploy-error-poll',
      p_event_key: `${expectedFiringKey}:resolved`,
      p_alertname: 'VercelDeploymentFailed',
      p_status: 'resolved',
      p_severity: 'info',
      p_payload: {
        resolves: expectedFiringKey,
        deploymentId: blockedId,
        successorDeploymentId: readyId,
        successorCommitSha: '9999cccc8888dddd',
      },
    });

    // 3. Repeat READY poll (even with a newer QUEUED build in front) emits ZERO duplicates and never resurrects BLOCKED.
    const callsAfterResolve = state.rpcCalls.length;
    phase = 'ready_with_queued';
    const repeatRes = await app.request('/cron/deploy-error-poll');
    expect(repeatRes.status).toBe(200);
    expect(await repeatRes.json()).toMatchObject({ action: 'ok', latestSha: '9999cccc8', resolvedAlerts: 0 });
    expect(state.rpcCalls.length).toBe(callsAfterResolve);
  });

  it('deploy-error-poll fails closed (503) if reading open firing alerts fails on a READY verdict', async () => {
    const now = Date.now();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      deployments: [{ uid: 'dpl_ok', state: 'READY', createdAt: now, meta: { githubCommitRef: 'main', githubCommitSha: 'abcdef123456' } }],
    }), { status: 200 })));

    // Fail specifically on the VercelDeploymentFailed lookup after DeploymentMonitorUnavailable succeeds.
    state.inboxReadError = { message: 'inbox unavailable' };

    const app = new Hono();
    app.get('/cron/deploy-error-poll', deployErrorPoll);
    const res = await app.request('/cron/deploy-error-poll');
    expect(res.status).toBe(503);
  });

  it('deploy-error-poll also resolves open AutofixRebuildFailed rows and ignores firing rows older than 7 days or newer than READY', async () => {
    const now = Date.now();
    const recentAutofixKey = operationalEventKey('dpl_autofix', 'Autofix Rebuild Failed');
    const ancientKey = operationalEventKey('dpl_ancient', 'Vercel Deployment Failed');
    state.inbox.push(
      {
        source: 'workers.deploy-error-poll',
        event_key: recentAutofixKey,
        alertname: 'AutofixRebuildFailed',
        status: 'firing',
        payload: { deploymentId: 'dpl_autofix' },
        received_at: new Date(now - 60_000).toISOString(),
        last_received_at: new Date(now - 60_000).toISOString(),
      },
      {
        source: 'workers.deploy-error-poll',
        event_key: ancientKey,
        alertname: 'VercelDeploymentFailed',
        status: 'firing',
        payload: { deploymentId: 'dpl_ancient' },
        received_at: new Date(now - 15 * 24 * 60 * 60_000).toISOString(),
        last_received_at: new Date(now - 15 * 24 * 60 * 60_000).toISOString(),
      },
    );

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      deployments: [
        { uid: 'dpl_ready', state: 'READY', createdAt: now - 10_000, meta: { githubCommitRef: 'main', githubCommitSha: '1234567890ab' } },
        { uid: 'dpl_autofix', state: 'ERROR', createdAt: now - 90_000, meta: { githubCommitRef: 'main', githubCommitSha: 'fedcba098765' } },
      ],
    }), { status: 200 })));

    const app = new Hono();
    app.get('/cron/deploy-error-poll', deployErrorPoll);
    const res = await app.request('/cron/deploy-error-poll');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: 'ok', resolvedAlerts: 1 });
    const resolved = state.rpcCalls.filter((c) => c.p_status === 'resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      p_alertname: 'AutofixRebuildFailed',
      p_event_key: `${recentAutofixKey}:resolved`,
      p_payload: { resolves: recentAutofixKey, successorDeploymentId: 'dpl_ready' },
    });
  });

  it('deploymentMonitorHealth links its resolved twin to the firing event_key via payload.resolves', async () => {
    await recordDeploymentMonitorHealth('firing', { summary: 'Vercel HTTP 503' });
    const firingKey = String(state.rpcCalls[0].p_event_key);
    await recordDeploymentMonitorHealth('resolved', { summary: 'Vercel healthy again' });
    expect(state.rpcCalls).toHaveLength(2);
    expect(state.rpcCalls[1]).toMatchObject({
      p_source: 'workers.deploy-error-poll',
      p_alertname: 'DeploymentMonitorUnavailable',
      p_status: 'resolved',
      p_payload: { resolves: firingKey },
    });
    expect(state.rpcCalls[1].p_event_key).not.toBe(firingKey);
  });

  it('scraper-watchdog links resolved twins to every firing key (stale -> dead escalation + recovery)', async () => {
    const ctx = () => ({ json: (body: unknown, status = 200) => ({ body, status }) });

    // Fire ScraperStale first
    state.freshScraper = false;
    state.minutesOld = 50;
    await scraperWatchdog(ctx() as never);
    const staleKey = String(state.rpcCalls[0].p_event_key);
    expect(state.rpcCalls[0].p_alertname).toBe('ScraperStale');

    // Cooldown expires and escalates to ScraperDead
    const raw = JSON.parse(state.watchdogState.get('pokeratlas_last_alert') ?? '{}');
    raw.last_alert_ms = Date.now() - 45 * 60_000;
    state.watchdogState.set('pokeratlas_last_alert', JSON.stringify(raw));
    state.minutesOld = 90;
    await scraperWatchdog(ctx() as never);
    const deadKey = String(state.rpcCalls[1].p_event_key);
    expect(state.rpcCalls[1].p_alertname).toBe('ScraperDead');

    // Scraper recovers -> BOTH firing keys must get resolved twins with payload.resolves
    state.freshScraper = true;
    await scraperWatchdog(ctx() as never);
    const resolved = state.rpcCalls.filter((c) => c.p_status === 'resolved');
    expect(resolved).toHaveLength(2);
    expect(resolved.map((r) => (r.p_payload as Record<string, unknown>).resolves).sort()).toEqual(
      [staleKey, deadKey].sort(),
    );
    for (const r of resolved) {
      expect(r.p_event_key).not.toBe((r.p_payload as Record<string, unknown>).resolves);
    }
  });

  it('video-library-scraper resolves open VideoLibraryScrapeFailed alerts on a clean full scrape, not on a single-source scrape', async () => {
    const failedRunId = '52680c63-8e37-41f8-9c8c-b2aa043017ee';
    const sourceRunId = '62680c63-8e37-41f8-9c8c-b2aa043017ee';
    const fullRunId = '72680c63-8e37-41f8-9c8c-b2aa043017ee';
    const base = () => ({
      ran_at: new Date(Date.now() - 10_000).toISOString(),
      completed_at: new Date().toISOString(),
      elapsed_s: 10,
      processed: 43,
      failed: 0,
      total_found: 100,
      total_new: 5,
      insert_failed: 0,
      metadata_failed: 0,
      errors: [] as string[],
    });

    const app = new Hono();
    app.all('/cron/video-library-scraper', videoLibraryScraper);

    // 1. Failing full scrape fires alert
    const failRes = await app.request('/cron/video-library-scraper?report=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base(), run_id: failedRunId, scope: 'full', failed: 2, errors: ['boom'] }),
    });
    expect(failRes.status).toBe(503);
    expect(state.rpcCalls).toHaveLength(1);

    // 2. Single-source clean scrape must NOT resolve the full-scrape failure
    const srcRes = await app.request('/cron/video-library-scraper?report=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base(), run_id: sourceRunId, scope: 'source', source_id: 'HCL' }),
    });
    expect(srcRes.status).toBe(200);
    expect(state.rpcCalls.filter((c) => c.p_status === 'resolved')).toHaveLength(0);

    // 3. Clean full scrape resolves the firing alert with payload.resolves = failedRunId
    const okRes = await app.request('/cron/video-library-scraper?report=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base(), run_id: fullRunId, scope: 'full' }),
    });
    expect(okRes.status).toBe(200);
    const resolved = state.rpcCalls.filter((c) => c.p_status === 'resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      p_source: 'video-library-scraper',
      p_event_key: `${failedRunId}:resolved`,
      p_alertname: 'VideoLibraryScrapeFailed',
      p_status: 'resolved',
      p_payload: { resolves: failedRunId, resolved_by_run_id: fullRunId },
    });
  });

  it('scraperAlerts resolves only the recovered scraperName on a clean evaluateAndAlert run', async () => {
    const now = new Date().toISOString();
    state.inbox.push(
      {
        source: 'workers.scraper',
        event_key: 'tour-fail-key',
        alertname: 'ScraperCritical',
        status: 'firing',
        payload: { scraper: 'tour-schedule-scraper', summary: '0 tours updated' },
        received_at: now,
        last_received_at: now,
      },
      {
        source: 'workers.scraper',
        event_key: 'other-scraper-key',
        alertname: 'ScraperCritical',
        status: 'firing',
        payload: { scraper: 'other-scraper', summary: 'still broken' },
        received_at: now,
        last_received_at: now,
      },
    );

    const res = await evaluateAndAlert('tour-schedule-scraper', {
      tours_scraped: 10,
      tours_updated: 10,
      tours_skipped: 0,
      total_events: 50,
      errors: [],
    });
    expect(res).toMatchObject({ sent: false, reason: 'no_alert_needed' });
    const resolved = state.rpcCalls.filter((c) => c.p_status === 'resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      p_source: 'workers.scraper',
      p_event_key: 'tour-fail-key:resolved',
      p_alertname: 'ScraperCritical',
      p_status: 'resolved',
      p_payload: { resolves: 'tour-fail-key', scraper: 'tour-schedule-scraper' },
    });
  });

  it('resolveOpenOperationalAlerts recognizes existing payload.resolves twins, hashes oversized keys safely, and rejects malformed rows', async () => {
    const now = new Date().toISOString();
    const longKey = 'k'.repeat(510);
    const hashedLongTwin = resolvedTwinEventKey(longKey);
    expect(hashedLongTwin.length).toBeLessThanOrEqual(512);
    expect(hashedLongTwin.endsWith(':resolved')).toBe(true);
    expect(hashedLongTwin).not.toBe(longKey);

    state.inbox.push(
      {
        source: 'workers.deploy-error-poll',
        event_key: 'custom-resolved-twin-key',
        alertname: 'VercelDeploymentFailed',
        status: 'resolved',
        payload: { resolves: 'already-resolved-by-payload' },
        received_at: now,
        last_received_at: now,
      },
      {
        source: 'workers.deploy-error-poll',
        event_key: 'already-resolved-by-payload',
        alertname: 'VercelDeploymentFailed',
        status: 'firing',
        payload: { deploymentId: 'dpl_old' },
        received_at: now,
        last_received_at: now,
      },
      {
        source: 'workers.deploy-error-poll',
        event_key: longKey,
        alertname: 'VercelDeploymentFailed',
        status: 'firing',
        payload: { deploymentId: 'dpl_long' },
        received_at: now,
        last_received_at: now,
      },
    );

    const result = await resolveOpenOperationalAlerts({
      source: 'workers.deploy-error-poll',
      alertnames: ['VercelDeploymentFailed'],
      buildPayload: () => ({ summary: 'cleared' }),
    });
    expect(result.skippedAlreadyResolved).toBe(1);
    expect(result.resolvedKeys).toEqual([longKey]);
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0]).toMatchObject({
      p_event_key: hashedLongTwin,
      p_status: 'resolved',
      p_payload: { resolves: longKey },
    });

    // Malformed row fails closed
    state.inbox.push({
      source: 'workers.deploy-error-poll',
      event_key: '',
      alertname: 'VercelDeploymentFailed',
      status: 'firing',
      payload: {},
      received_at: now,
      last_received_at: now,
    });
    await expect(
      resolveOpenOperationalAlerts({
        source: 'workers.deploy-error-poll',
        alertnames: ['VercelDeploymentFailed'],
        buildPayload: () => ({ summary: 'cleared' }),
      }),
    ).rejects.toBeInstanceOf(OperationalAlertDeliveryError);
  });
});
