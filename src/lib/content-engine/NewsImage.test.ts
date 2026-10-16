import { afterEach, describe, expect, it, vi } from 'vitest';
import Parser from 'rss-parser';
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
  it('reads real rss-parser output instead of assuming raw XML description survives', async () => {
    const parser = new Parser();
    const parsed = await parser.parseString('<rss version="2.0"><channel><title>PokerNews</title><item><title>Adrian Mateos</title><link>https://www.pokernews.com/news/2026/10/story-52617.htm</link><description><![CDATA[<img src="https://s.pnimg.net/story52617.webp" /><p>Actual story summary.</p>]]></description></item></channel></rss>');
    expect(parsed.items[0]).not.toHaveProperty('description');
    expect(extractArticleImageUrl(parsed.items[0]!)).toBe('https://s.pnimg.net/story52617.webp');
  });
  it('reads preserved Media RSS arrays and refuses a leading generic logo', async () => {
    const parser = new Parser({ customFields: { item: [['media:content', 'media:content', { keepArray: true }]] } });
    const parsed = await parser.parseString('<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>News</title><item><title>Story</title><media:content url="https://cdn.example/logo.jpg"/><media:content url="https://cdn.example/story.jpg"/></item></channel></rss>');
    expect(extractArticleImageUrl(parsed.items[0]!)).toBe('https://cdn.example/story.jpg');
  });
});

describe('exact public CardPlayer story metadata', () => {
  const link = 'https://www.cardplayer.com/poker-news/1762590-2026-card-player-poy-race';
  const image = 'https://www.cardplayer.com/wp-content/uploads/2026/10/POY-Update-October-scaled.jpg';
  const html = (canonical = link, artwork = image) => `<meta content="${canonical}" property="og:url"><meta property='og:image' content='${artwork}'>`;
  it('fetches only the exact public story and requires matching article identity', async () => {
    const fetcher = vi.fn(async () => new Response(html(), { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetcher);
    expect(await resolveArticleImageUrl({ link: `${link}?utm_source=rss` })).toBe(image);
    expect(fetcher.mock.calls[0]?.[0]).toBe(link);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });
  it.each(['mismatch', 'logo', 'oversize', 'refused', 'not_html'])('fails closed for %s instead of inventing artwork', async mode => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      mode === 'oversize' ? ' '.repeat(524289) : html(mode === 'mismatch' ? `${link}-different` : link, mode === 'logo' ? 'https://cdn.example/logo.jpg' : image),
      { status: mode === 'refused' ? 429 : 200, headers: { 'content-type': mode === 'not_html' ? 'application/json' : 'text/html' } },
    )));
    expect(await resolveArticleImageUrl({ link })).toBeNull();
  });
  it('refuses lookalike domains, other paths, nonstandard ports and insecure story fetches', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const value of [link.replace('www.cardplayer.com', 'www.cardplayer.com.evil.test'), link.replace('/poker-news/', '/account/'), link.replace('https:', 'http:'), link.replace('.com/', '.com:8443/')]) {
      expect(await resolveArticleImageUrl({ link: value })).toBeNull();
    }
    expect(fetcher).not.toHaveBeenCalled();
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
