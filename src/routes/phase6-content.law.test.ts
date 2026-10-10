import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./phase6-content.ts', import.meta.url), 'utf8');

describe('Phase 6 publishing laws', () => {
  it('checks the master switch before any live composition', () => {
    const handler = source.slice(source.indexOf('export async function phase6Content'));
    expect(handler.indexOf('await engineEnabled()')).toBeGreaterThan(0);
    expect(handler.indexOf('await engineEnabled()')).toBeLessThan(handler.indexOf('await composePhase6('));
    expect(handler.indexOf('await postModeEnabled(mode)')).toBeLessThan(handler.indexOf('await composePhase6('));
  });

  it('names all three independent approval modes', () => {
    expect(source).toContain("'club_data_digest'");
    expect(source).toContain("'local_event'");
    expect(source).toContain("'seasonal_local'");
    expect(source).toContain('await postModeEnabled(mode)');
  });

  it('keeps preview explicitly free of content writes', () => {
    const previewBlock = source.slice(source.indexOf('if (preview) {'), source.indexOf('const results:'));
    expect(previewBlock).toContain('content_writes: 0');
    expect(previewBlock).toContain('writes_note: PREVIEW_WRITES_NOTE');
    expect(previewBlock).not.toContain('publishMode(');
  });

  it('never writes the video-library publication_key column; the key lives in metadata', () => {
    // Only metadataFor() may mention publication_key, and only as a metadata field.
    const mentions = source.split('\n').filter((line) => /publication_key\s*:/.test(line));
    expect(mentions).toEqual(['    publication_key: draft.publicationKey,']);
    const metadataFor = source.slice(source.indexOf('function metadataFor'), source.indexOf('async function publishClubDraft'));
    expect(metadataFor).toContain('publication_key: draft.publicationKey');
    const ledger = source.slice(source.indexOf('async function publishedKeys'), source.indexOf('type PublishOutcome'));
    expect(ledger).toContain(".in('metadata->>publication_key', chunk)");
    expect(ledger).toContain("row.metadata?.publication_key");
  });

  it('writes the club feed mirror only for a page_and_feed digest, after the page post', () => {
    const club = source.slice(source.indexOf('async function publishClubDraft'), source.indexOf('async function publishHorseDraft'));
    const pageOnly = club.indexOf("draft.publish === 'page_only'");
    expect(pageOnly).toBeGreaterThan(club.indexOf(".from('social_page_posts')"));
    expect(pageOnly).toBeLessThan(club.indexOf(".from('social_posts')"));
    expect(club).toContain("mirror: 'skipped_author_not_horse'");
    expect(source).toContain('mirror_skipped_author_not_horse: 0');
  });

  it('checks a page-post rollback and never claims it when the delete failed', () => {
    const club = source.slice(source.indexOf('async function publishClubDraft'), source.indexOf('async function publishHorseDraft'));
    expect(club).toMatch(/const \{ data: removed, error: rollbackError \} = await supa\s*\.from\('social_page_posts'\)\s*\.delete\(\)\s*\.eq\('id', pagePost\.id\)/);
    expect(club.indexOf('rollbackError ||')).toBeLessThan(club.indexOf('rolled back'));
  });
});
