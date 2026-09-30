/**
 * Phase 7 route laws: static reads of src/routes/phase7-content.ts,
 * src/lib/content-engine/Phase7Content.ts and src/index.ts, in the shape of
 * phase6-content.law.test.ts and the horse-video-reels wiring test. They pin
 * the properties the behavioural tests cannot see from outside: where the
 * switch is read, what may never be written, and that nothing here schedules
 * or retries anything.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const route = readFileSync(new URL('./phase7-content.ts', import.meta.url), 'utf8');
const run = readFileSync(new URL('../lib/content-engine/Phase7Content.ts', import.meta.url), 'utf8');
const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

/** The text of one top-level function, from its declaration to the next one. */
function fn(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `${declaration} exists`).toBeGreaterThan(-1);
  const rest = source.slice(start + declaration.length);
  const next = rest.search(/\n(?:export )?(?:async )?function |\n\/\/ -----/);
  return next === -1 ? source.slice(start) : source.slice(start, start + declaration.length + next);
}

/** Source with its comments removed, so a law reads code and not prose. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
}

describe('Phase 7 route wiring', () => {
  it('is registered for GET and POST behind the cron guards, next to phase6-content', () => {
    expect(index).toContain("import { phase7Content } from './routes/phase7-content.js';");
    const ipGuard = index.indexOf("app.use('/cron/*', ipAllowlist);");
    const secretGuard = index.indexOf("app.use('/cron/*', requireCronSecret);");
    const phase6Post = index.indexOf("app.post('/cron/phase6-content', phase6Content);");
    const getRoute = index.indexOf("app.get('/cron/phase7-content', phase7Content);");
    const postRoute = index.indexOf("app.post('/cron/phase7-content', phase7Content);");
    expect(ipGuard).toBeGreaterThan(-1);
    expect(secretGuard).toBeGreaterThan(ipGuard);
    expect(phase6Post).toBeGreaterThan(secretGuard);
    expect(getRoute).toBeGreaterThan(phase6Post);
    expect(getRoute - phase6Post).toBeLessThan(400);
    expect(postRoute).toBeGreaterThan(getRoute);
    expect(index.match(/phase7-content/g)).toHaveLength(3);
  });

  it('reads the master switch before a live run and never before a preview', () => {
    const handler = route.slice(route.indexOf('export async function phase7Content'));
    const liveBlock = handler.slice(handler.indexOf('if (!preview) {'), handler.indexOf('return c.json(await previewPhase7('));
    expect(liveBlock.indexOf('await engineEnabled()')).toBeGreaterThan(-1);
    expect(liveBlock.indexOf('await engineEnabled()')).toBeLessThan(liveBlock.indexOf('await runPhase7('));
    expect(liveBlock).toContain("skipped: 'engine_disabled'");
    expect(liveBlock).not.toContain('previewPhase7(');
    expect(route).not.toMatch(/\bpostModeEnabled\b/);
  });
});

describe('Phase 7 run laws', () => {
  it('asks the switch again, fresh, before every write', () => {
    const mayWrite = fn(run, 'async function mayWrite(');
    expect(mayWrite).toContain('await engineSwitch({ fresh: true })');
    expect(mayWrite.indexOf('state.deadlineHit = true')).toBeLessThan(mayWrite.indexOf('await engineSwitch('));

    const reveal = fn(run, 'async function revealStep(');
    expect(reveal.indexOf('if (!(await mayWrite(state))) break;')).toBeGreaterThan(-1);
    expect(reveal.indexOf('if (!(await mayWrite(state))) break;')).toBeLessThan(reveal.indexOf("rpc('fn_p7_reveal_puzzle'"));

    const puzzle = fn(run, 'async function puzzleStep(');
    expect(puzzle.indexOf('await mayWrite(state)')).toBeGreaterThan(-1);
    expect(puzzle.indexOf('await mayWrite(state)')).toBeLessThan(puzzle.indexOf('await publishPuzzle(state,'));

    const story = fn(run, 'async function storyStep(');
    expect(story.indexOf('await mayWrite(state)')).toBeGreaterThan(-1);
    expect(story.indexOf('await mayWrite(state)')).toBeLessThan(story.indexOf('await publishStory(state.supa,'));

    // The three write sites are the only ones.
    expect(run.match(/\.rpc\(/g)).toHaveLength(2);
    expect(run.match(/\.insert\(/g)).toHaveLength(1);
    expect(run).not.toMatch(/\.(upsert|update|delete)\(/);
  });

  it('keeps the correct option out of post metadata, grounding and every log line', () => {
    const metadataLines = run.split('\n').filter((line) => /p_metadata\s*:/.test(line));
    expect(metadataLines).toEqual(["      p_metadata: { scheduler: 'phase7', grounding: groundingFor(row) },"]);
    const grounding = code(fn(run, 'export function groundingFor('));
    expect(grounding).not.toMatch(/correct|explanation|option|salt|net_bb|is_win|pot_size|hole_cards/);
    for (const line of run.split('\n').filter((l) => l.includes('console.'))) {
      expect(line).not.toMatch(/correct|explanation|salt|option|prompt/);
    }
    // Outside the owner's zero-write preview, the answer is named exactly once: as the RPC's own argument.
    const live = run.slice(0, run.indexOf('// Preview: compose everything, write nothing, call no RPC'));
    const mentions = live.split('\n').filter((line) => line.includes('correct_option'));
    expect(mentions).toEqual(['      p_correct_option: puzzle.correct_option,']);
    expect(live.split('\n').filter((line) => line.includes('explanation'))).toEqual(['      p_explanation: puzzle.explanation,']);
  });

  it('never writes the publication_key column; the key lives in metadata, and never in the fleet namespace', () => {
    const mentions = run.split('\n').filter((line) => /publication_key\s*:/.test(line));
    expect(mentions).toEqual(['    publication_key: draft.publication_key,']);
    const storyMetadata = fn(run, 'export function storyMetadata(');
    expect(storyMetadata).toContain('publication_key: draft.publication_key');
    expect(run).toContain(".eq('metadata->>publication_key', publicationKey)");
    expect(run).not.toMatch(/['`]fleet:/);
    expect(route).not.toContain('publication_key');
  });

  it('keeps preview explicitly free of content writes and RPC calls', () => {
    const preview = run.slice(run.indexOf('export async function previewPhase7('));
    expect(preview).toContain('content_writes: 0');
    expect(preview).toContain('writes_note: PREVIEW_WRITES_NOTE');
    expect(preview).not.toMatch(/\.(rpc|insert|upsert|update|delete)\(/);
    expect(preview).not.toMatch(/recordPhrase\(|mayWrite\(|postModeEnabled\(|recentPostGuard\(|guardFor\(/);
    expect(run).toContain("'Preview makes no content writes: no posts, puzzles, reveals, rewards or phrase-ledger rows, and it calls no RPC. '");
  });

  it('is one bounded pass: fixed caps, oldest first, no timer, retry loop or parallel writes', () => {
    expect(run).toContain('export const REVEALS_PER_RUN = 50;');
    expect(run).toContain('export const PUZZLES_PER_KIND_PER_RUN = 3;');
    expect(run).toContain('export const CANDIDATE_LIMIT = 200;');
    expect(run).toContain('export const CANDIDATE_MIN_ABS_BB = 25;');
    expect(run).toContain('export const DEADLINE_MS = 240_000;');
    expect(run).toContain('export const CONCURRENCY = 1;');
    const reveal = fn(run, 'async function revealStep(');
    expect(reveal).toMatch(/\.is\('revealed_at', null\)[\s\S]*\.lte\('reveal_at', state\.now\.toISOString\(\)\)[\s\S]*\.order\('reveal_at', \{ ascending: true \}\)[\s\S]*\.limit\(REVEALS_PER_RUN\)/);
    const candidates = fn(run, 'async function readCandidates(');
    expect(candidates).toMatch(/\.eq\('game_variant', 'nlh'\)[\s\S]*\.order\('played_at', \{ ascending: false \}\)[\s\S]*\.limit\(CANDIDATE_LIMIT\)/);
    for (const source of [route, run]) {
      expect(code(source)).not.toMatch(/setTimeout|setInterval|setImmediate|Promise\.all|Promise\.allSettled|while \(true\)|\bretry|\bcron\.|schedule\(/);
    }
    expect(run.split('\n').filter((line) => /\bfor\s*\(/.test(line)).length).toBeGreaterThan(0);
  });

  it('fails closed on every unreadable input', () => {
    expect(fn(run, 'async function guardFor(')).toContain("return 'guard_unreadable';");
    expect(fn(run, 'async function readCandidates(')).toContain("if (error) throw new Error(`horse_hand_reviews read failed: ${error.message}`);");
    expect(fn(run, 'async function puzzleKeyExists(')).toContain('if (error) throw new Error(');
    expect(fn(run, 'async function alreadyPublished(')).toContain('if (error) throw new Error(');
    const reveal = fn(run, 'async function revealStep(');
    expect(reveal).toContain('out.read_failed = true;');
    const mayWrite = fn(run, 'async function mayWrite(');
    expect(mayWrite).toContain("state.halt = switchState === 'off' ? 'engine_disabled' : 'engine_unreadable';");
  });
});
