import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const provider = ['sen', 'try'].join('');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function sourceFiles(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return file.endsWith('.ts') && !file.endsWith('.test.ts') ? [file] : [];
  });
}

test('worker dependency and environment configuration cannot restore the retired provider', () => {
  for (const file of ['package.json', 'package-lock.json', '.env.example', 'docker-compose.yml', 'Dockerfile']) {
    assert.doesNotMatch(read(file), new RegExp(String.raw`@${provider}(?:-internal)?/|\b${provider}_[A-Z_]+|${provider}\.io`, 'i'), file);
  }
});

test('worker runtime has no retired SDK, activation key or external error destination', () => {
  for (const file of sourceFiles('src')) {
    assert.doesNotMatch(read(file), new RegExp(String.raw`\b${provider}\b|\b${provider}_[A-Z_]+|${provider}\.io`, 'i'), file);
  }
});

test('the provider-only scheduled route and dispatcher are removed', () => {
  assert.doesNotMatch(read('src/index.ts'), /clawbotOrchestrator|clawbot-orchestrator/);
  for (const file of ['src/routes/clawbot-orchestrator.ts', 'src/lib/clawbot-audit.ts']) {
    assert.equal(fs.existsSync(path.join(root, file)), false, `${file} must remain retired`);
  }
});


test('container dependency layers require the reviewed lockfile', () => {
  const dockerfile = read('Dockerfile');
  const dependencySteps = dockerfile.split('\n').filter((line) => /^RUN npm (?:install|ci)\b/.test(line));
  assert.deepEqual(dependencySteps, [
    'RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts --legacy-peer-deps',
    'RUN npm ci --no-audit --no-fund --ignore-scripts --legacy-peer-deps',
  ]);
});
