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
});
