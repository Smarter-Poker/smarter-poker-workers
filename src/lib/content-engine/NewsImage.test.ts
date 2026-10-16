import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetArticleImageCache, extractArticleImageUrl, resolveArticleImageUrl, safeArticleUrl } from './NewsImage.js';

afterEach(()=>{vi.unstubAllGlobals();_resetArticleImageCache();});

describe('article image extraction', () => {
  it.each([
    [{ enclosure: { url: 'https://cdn.example/enclosure.webp' } }, 'https://cdn.example/enclosure.webp'],
    [{ 'media:content': { $: { url: 'https://cdn.example/media.jpg' } } }, 'https://cdn.example/media.jpg'],
    [{ 'media:thumbnail': { $: { url: 'https://cdn.example/thumb.png' } } }, 'https://cdn.example/thumb.png'],
    [{ 'content:encoded': '<p><img src="https://cdn.example/story.jpeg" alt="story"></p>' }, 'https://cdn.example/story.jpeg'],
    [{ description: "<img src='https://cdn.example/description.webp'>" }, 'https://cdn.example/description.webp'],
  ])('uses the maintained RSS image shapes', (item, expected) => {
    expect(extractArticleImageUrl(item)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)',
    'ftp://cdn.example/story.jpg',
    'https://cdn.example/favicon.ico',
    'https://cdn.example/publisher-logo.png',
    'https://cdn.example/placeholder.jpg',
    'https://s.w.org/images/core/emoji/17.0.2/72x72/1f609.png',
    'https://cdn.example/wp-smilies/wink.png',
    'https://a.espncdn.com/combiner/i?img=%2Fi%2Fespn%2Fespn_logos%2Fespn_red.png&w=1200&h=630',
  ])('rejects unsafe or generic artwork: %s', (url) => {
    expect(extractArticleImageUrl({ enclosure: { url } })).toBeNull();
  });

  it('skips an inline emoji and keeps scanning for the real story image', () => {
    expect(extractArticleImageUrl({
      'content:encoded': [
        '<p><img src="https://s.w.org/images/core/emoji/17.0.2/72x72/1f609.png"></p>',
        '<figure><img src="https://cdn.example/stories/table-action.webp"></figure>',
      ].join(''),
    })).toBe('https://cdn.example/stories/table-action.webp');
  });
});

describe('bounded first-party story art resolution', () => {
  it('resolves ESPN fantasy stories through the exact numeric article identity, not a generic share logo', async () => {
    const fetcher=vi.fn(async ()=>new Response(JSON.stringify({headlines:[{id:'50189270',images:[{url:'https://a.espncdn.com/photo/2026/1015/r1731149_1296x729_16-9.jpg'}]}]}),{status:200}));
    vi.stubGlobal('fetch',fetcher);
    expect(await resolveArticleImageUrl({link:'https://www.espn.com/fantasy/basketball/story/_/id/50189270/backup-plan'})).toBe('https://a.espncdn.com/photo/2026/1015/r1731149_1296x729_16-9.jpg');
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://content.core.api.espn.com/v1/sports/news/50189270');
  });
  it.each(['mismatch','logo','unavailable','too_large'])('fails closed for %s metadata', async mode => {
    vi.stubGlobal('fetch',vi.fn(async ()=>mode==='unavailable'?new Response('',{status:503}):new Response(mode==='too_large'?' '.repeat(262145):JSON.stringify({headlines:[{id:mode==='mismatch'?'999':'50189270',images:[{url:'https://a.espncdn.com/i/espn/espn_logos/espn_red.png'}]}]}),{status:200})));
    expect(await resolveArticleImageUrl({link:'https://www.espn.com/nba/story/_/id/50189270/story'})).toBeNull();
  });
  it('does not fetch arbitrary article URLs or URL-shaped story identifiers', async () => {
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    expect(await resolveArticleImageUrl({link:'https://untrusted.example/story/_/id/50189270'})).toBeNull();
    expect(await resolveArticleImageUrl({link:'https://www.espn.com/story/_/id/http://untrusted.example'})).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent and repeated lookups for the exact story', async () => {
    const fetcher=vi.fn(async ()=>new Response(JSON.stringify({headlines:[{id:'50189270',images:[{url:'https://a.espncdn.com/photo/story-50189270.jpg'}]}]}),{status:200}));
    vi.stubGlobal('fetch',fetcher);
    const item={link:'https://www.espn.com/fantasy/basketball/story/_/id/50189270/backup-plan'};
    expect(await Promise.all([resolveArticleImageUrl(item),resolveArticleImageUrl(item)])).toEqual(['https://a.espncdn.com/photo/story-50189270.jpg','https://a.espncdn.com/photo/story-50189270.jpg']);
    await resolveArticleImageUrl(item);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('article URL validation', () => {
  it('canonicalises ordinary web article URLs', () => {
    expect(safeArticleUrl(' https://news.example/story?q=1 ')).toBe('https://news.example/story?q=1');
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@news.example/story', 'not a url'])(
    'rejects an unsafe article URL: %s',
    (value) => expect(safeArticleUrl(value)).toBeNull(),
  );
});
