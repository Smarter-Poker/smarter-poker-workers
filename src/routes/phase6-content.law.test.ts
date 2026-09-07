import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./phase6-content.ts', import.meta.url), 'utf8');

describe('Phase 6 publishing laws', () => {
  it('checks the master switch before any live composition', () => {
    const handler = source.slice(source.indexOf('export async function phase6Content'));
    expect(handler.indexOf('await engineEnabled()')).toBeGreaterThan(0);
    expect(handler.indexOf('await engineEnabled()')).toBeLessThan(handler.indexOf('await readClubDrafts'));
    expect(handler.indexOf('await engineEnabled()')).toBeLessThan(handler.indexOf('await readLocalDrafts'));
  });

  it('names all three independent approval modes', () => {
    expect(source).toContain("'club_data_digest'");
    expect(source).toContain("'local_event'");
    expect(source).toContain("'seasonal_local'");
    expect(source).toContain('await postModeEnabled(mode)');
  });

  it('keeps preview explicitly non-writing', () => {
    const previewBlock = source.slice(source.indexOf('if (preview) {'), source.indexOf('const results:'));
    expect(previewBlock).toContain('writes: 0');
    expect(previewBlock).not.toContain('publishMode(');
  });

  it('rolls a page post back if its global-feed mirror fails', () => {
    expect(source).toMatch(/feedError[\s\S]*?social_page_posts'\)\.delete\(\)\.eq\('id', pagePost\.id\)/);
  });
});
