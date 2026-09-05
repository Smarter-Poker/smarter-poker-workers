/**
 * ContentLedger: the pure parts. The database parts are exercised by the
 * migration's own probe and by the route's result counts in
 * cron_execution_log; nothing here talks to Supabase.
 */
import { describe, it, expect } from 'vitest';
import { assetKeyFor, normalizePhrase } from './ContentLedger.js';

describe('assetKeyFor', () => {
  it('collapses every YouTube URL form to one key', () => {
    const forms = [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    ];
    for (const f of forms) expect(assetKeyFor(f)).toBe('yt:dQw4w9WgXcQ');
  });

  it('keys articles by host and path, dropping the query and trailing slash', () => {
    expect(assetKeyFor('https://upswingpoker.com/some-article/?utm=x')).toBe('url:upswingpoker.com/some-article');
    expect(assetKeyFor('https://UPSWINGPOKER.com/some-article')).toBe('url:upswingpoker.com/some-article');
  });

  it('matches the SQL seed in the migration for the same inputs', () => {
    // The migration derives 'url:<host><path>' with the query stripped and
    // trailing slashes removed; the same three cases are pinned there.
    expect(assetKeyFor('https://www.cardplayer.com/poker-news/1/title/')).toBe('url:www.cardplayer.com/poker-news/1/title');
  });

  it('returns null for nothing', () => {
    expect(assetKeyFor(null)).toBeNull();
    expect(assetKeyFor('')).toBeNull();
  });
});

describe('normalizePhrase', () => {
  it('takes the first line, lower-cases, strips punctuation and links', () => {
    expect(normalizePhrase('Nobody touches him when he is locked in!\n\nhttps://x.y/z')).toBe(
      'nobody touches him when he is locked in',
    );
    expect(normalizePhrase("  It's   REAL,  talk. ")).toBe('its real talk');
  });

  it('matches the SQL seed normalisation', () => {
    // regexp_replace(regexp_replace(lower(first_line), '[^a-z0-9\s]', '', 'g'), '\s+', ' ', 'g')
    expect(normalizePhrase('Hard to argue with how antonius played that one')).toBe(
      'hard to argue with how antonius played that one',
    );
  });
});
