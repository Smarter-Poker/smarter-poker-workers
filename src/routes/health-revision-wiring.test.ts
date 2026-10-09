import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function repositoryFile(path: string): Promise<string> {
  return readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
}

describe('worker revision wiring', () => {
  it('carries GIT_SHA into the runtime image, not only the build stage', async () => {
    const dockerfile = await repositoryFile('Dockerfile');
    const runtimeStage = dockerfile.split('FROM node:20-alpine AS runtime')[1];

    expect(runtimeStage).toBeDefined();
    expect(runtimeStage).toContain('ARG GIT_SHA=dev');
    expect(runtimeStage).toContain('ENV GIT_SHA=$GIT_SHA');
  });

  it('injects the exact revision in both automatic and manual server builds', async () => {
    const [automaticDeploy, manualDeploy, release] = await Promise.all([
      repositoryFile('.github/workflows/auto-deploy-workers.yml'),
      repositoryFile('scripts/deploy-workers.sh'),
      repositoryFile('.github/workflows/release.yml'),
    ]);

    expect(automaticDeploy).toContain('docker build --build-arg GIT_SHA=$SHA');
    expect(automaticDeploy).toContain('grep -q "\\"version\\":\\"$SHA\\""');
    expect(manualDeploy).toContain('docker build --build-arg GIT_SHA=$FULL_SHA');
    expect(manualDeploy).toContain('grep -q "\\"version\\":\\"$FULL_SHA\\""');
    expect(release).toContain('GIT_SHA=${{ github.sha }}');
  });

  it('keeps long VM cutovers alive without deploying workflow-only maintenance', async () => {
    const workflow = await repositoryFile('.github/workflows/auto-deploy-workers.yml');

    expect(workflow).toContain("- 'src/**'");
    expect(workflow).toContain("- 'docker-compose.yml'");
    expect(workflow).not.toContain("- '.github/workflows/auto-deploy-workers.yml'");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow.match(/ServerAliveInterval=30/g)).toHaveLength(2);
    expect(workflow.match(/ServerAliveCountMax=20/g)).toHaveLength(2);
  });

  it('keeps the one-shot sports refresh opt-in, exact-revision, bounded and secret-safe', async () => {
    const workflow = await repositoryFile('.github/workflows/auto-deploy-workers.yml');

    expect(workflow).toContain('run_sports_scrape:');
    expect(workflow).toMatch(/run_sports_scrape:[\s\S]*?default: false[\s\S]*?type: boolean/);
    expect(workflow).toContain(
      "if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.run_sports_scrape == true",
    );
    expect(workflow).toContain("if [ \"$REQUEST_REF\" != 'refs/heads/main' ]");
    expect(workflow).toContain('the one-shot sports refresh may run only from protected main');
    expect(workflow).toContain('http://127.0.0.1:8081/cron/scrape-sports-clips');
    expect(workflow.match(/127\.0\.0\.1:8081\/cron\/scrape-sports-clips/g)).toHaveLength(1);
    expect(workflow.match(/fetch\(/g)).toHaveLength(1);
    expect(workflow).toContain('process.env.CRON_SECRET');
    expect(workflow).toContain('AbortSignal.timeout(285000)');
    expect(workflow).toContain('[ "$REV" = "$SHORT" ]');
    expect(workflow).toContain('sports-scrape-receipt.json');
    expect(workflow).toContain("failureCode: process.env.FAILURE_CODE");
    expect(workflow).toContain("reject(value, 'counter_mismatch'");
    expect(workflow).toContain("if: always() && github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain('value.saved + value.skipped + value.repaired !== value.found');
    expect(workflow).not.toContain('/cron/horse-video-reels');
  });
});
