/**
 * GET/POST /cron/news-scraper
 *
 * Ported from pages/api/cron/news-scraper.js (1420 lines).
 *
 * Every 2 hours: pulls 6 sources (PokerNews/MSPT/CardPlayer/WSOP/
 * Poker.org/Pokerfuse) in parallel via Promise.allSettled; saves new
 * articles to poker_news (upsert on source_url, ignoreDuplicates=true);
 * mirror-posts each new article to social_posts as the news-poster
 * account. Archives poker_news rows older than RETENTION_DAYS=3.
 *
 * Per-source pipelines:
 *   Box 1 PokerNews   — RSS-first (hybrid). Falls back to /news/ HTML
 *                       scrape, then video page if all dups.
 *   Box 2 MSPT        — direct scrape of Magazine.aspx (ASP.NET, mobile
 *                       Safari UA preferred). Card-container regex
 *                       parses background-image + <h1><a> + title.
 *   Box 3 CardPlayer  — RSS only (HTML returns 403).
 *   Box 4 WSOP        — direct scrape of /news/. Multiple regex patterns.
 *   Box 5 Poker.org   — sitemap scrape (article-YYYY-M.xml). Title
 *                       reconstructed from URL slug.
 *   Box 6 Pokerfuse   — direct scrape of homepage. /latest-news/YYYY/M
 *                       URL pattern + h2/h3 fallback patterns.
 *
 * Image extraction (5-layer fallback):
 *   1. RSS enclosure/media:content/media:thumbnail
 *   2. Article-page og:image + twitter:image + JSON-LD
 *   3. Featured-image / article-content <img>
 *   4. fastFailImageProxy: Promise.any over microlink + noembed +
 *      Google Cache (5s hard timeout)
 *   5. CardPlayer-specific CDN URL guess on article ID
 *
 * If still no image → contextual keyword fallback image (Pexels
 * stock by title keyword).
 *
 * Idempotence: poker_news.source_url upsert with ignoreDuplicates=true,
 * social_posts content LIKE %url% pre-check before posting.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import RssParser from 'rss-parser';
import { getSupabase } from '../lib/supabase.js';

const CONFIG = {
  MAX_ARTICLES_PER_SOURCE: 5,
  RETENTION_DAYS: 3,
  REQUEST_TIMEOUT: 12000,
  IMAGE_PROXY_TIMEOUT: 5000,
} as const;

const NEWS_POSTER_UUID = '2d1cd6c3-5700-4af9-a271-d4863fdab20d';

const rssParser = new RssParser({
  customFields: {
    item: ['media:content', 'media:thumbnail', 'content:encoded', 'enclosure'],
  },
});

interface NewsSource {
  box: number;
  name: string;
  type: 'rss' | 'scrape' | 'hybrid';
  url: string;
  scrapeUrl?: string;
  videoUrl?: string;
  baseUrl: string;
  icon: string;
  category: string;
}

interface Article {
  url: string;
  title: string;
  image: string;
  source: NewsSource;
  /** ISO publication date from the feed, when the source provides one. */
  publishedAt?: string | null;
}

const NEWS_SOURCES: NewsSource[] = [
  {
    box: 1,
    name: 'PokerNews',
    type: 'hybrid',
    url: 'https://www.pokernews.com/rss.php',
    scrapeUrl: 'https://www.pokernews.com/news/',
    videoUrl: 'https://www.pokernews.com/video/most-recent/',
    baseUrl: 'https://www.pokernews.com',
    icon: '🃏',
    category: 'news',
  },
  {
    box: 2,
    name: 'MSPT',
    type: 'scrape',
    url: 'https://msptpoker.com/pages/Magazine.aspx',
    baseUrl: 'https://msptpoker.com',
    icon: '🃏',
    category: 'tournament',
  },
  {
    box: 3,
    name: 'CardPlayer',
    type: 'rss',
    url: 'https://www.cardplayer.com/poker-news.rss',
    baseUrl: 'https://www.cardplayer.com',
    icon: '♠️',
    category: 'news',
  },
  {
    box: 4,
    name: 'WSOP',
    type: 'scrape',
    url: 'https://www.wsop.com/news/',
    baseUrl: 'https://www.wsop.com',
    icon: '🏆',
    category: 'tournament',
  },
  {
    box: 5,
    name: 'Poker.org',
    type: 'scrape',
    url: 'https://www.poker.org/',
    baseUrl: 'https://www.poker.org',
    icon: '♦️',
    category: 'news',
  },
  {
    box: 6,
    name: 'Pokerfuse',
    type: 'scrape',
    url: 'https://pokerfuse.com/',
    baseUrl: 'https://pokerfuse.com',
    icon: '🔥',
    category: 'industry',
  },
];

// ── Contextual fallback images (Pexels) ────────────────────────────────────
const KEYWORD_IMAGES: Record<string, string> = {
  tournament: 'https://images.pexels.com/photos/6664248/pexels-photo-6664248.jpeg?auto=compress&cs=tinysrgb&w=600',
  wsop: 'https://images.pexels.com/photos/6664248/pexels-photo-6664248.jpeg?auto=compress&cs=tinysrgb&w=600',
  bracelet: 'https://images.pexels.com/photos/6664248/pexels-photo-6664248.jpeg?auto=compress&cs=tinysrgb&w=600',
  ring: 'https://images.pexels.com/photos/6664248/pexels-photo-6664248.jpeg?auto=compress&cs=tinysrgb&w=600',
  wpt: 'https://images.pexels.com/photos/3279691/pexels-photo-3279691.jpeg?auto=compress&cs=tinysrgb&w=600',
  win: 'https://images.pexels.com/photos/6664248/pexels-photo-6664248.jpeg?auto=compress&cs=tinysrgb&w=600',
  victory: 'https://images.pexels.com/photos/6664248/pexels-photo-6664248.jpeg?auto=compress&cs=tinysrgb&w=600',
  champion: 'https://images.pexels.com/photos/6664248/pexels-photo-6664248.jpeg?auto=compress&cs=tinysrgb&w=600',
  million: 'https://images.pexels.com/photos/4386366/pexels-photo-4386366.jpeg?auto=compress&cs=tinysrgb&w=600',
  'high stakes': 'https://images.pexels.com/photos/4386366/pexels-photo-4386366.jpeg?auto=compress&cs=tinysrgb&w=600',
  pot: 'https://images.pexels.com/photos/4386366/pexels-photo-4386366.jpeg?auto=compress&cs=tinysrgb&w=600',
  cash: 'https://images.pexels.com/photos/4386366/pexels-photo-4386366.jpeg?auto=compress&cs=tinysrgb&w=600',
  online: 'https://images.pexels.com/photos/4254890/pexels-photo-4254890.jpeg?auto=compress&cs=tinysrgb&w=600',
  ggpoker: 'https://images.pexels.com/photos/4254890/pexels-photo-4254890.jpeg?auto=compress&cs=tinysrgb&w=600',
  pokerstars: 'https://images.pexels.com/photos/4254890/pexels-photo-4254890.jpeg?auto=compress&cs=tinysrgb&w=600',
  casino: 'https://images.pexels.com/photos/3279691/pexels-photo-3279691.jpeg?auto=compress&cs=tinysrgb&w=600',
  bill: 'https://images.pexels.com/photos/4386331/pexels-photo-4386331.jpeg?auto=compress&cs=tinysrgb&w=600',
  law: 'https://images.pexels.com/photos/4386331/pexels-photo-4386331.jpeg?auto=compress&cs=tinysrgb&w=600',
  legal: 'https://images.pexels.com/photos/4386331/pexels-photo-4386331.jpeg?auto=compress&cs=tinysrgb&w=600',
  tax: 'https://images.pexels.com/photos/4386331/pexels-photo-4386331.jpeg?auto=compress&cs=tinysrgb&w=600',
  player: 'https://images.pexels.com/photos/1871508/pexels-photo-1871508.jpeg?auto=compress&cs=tinysrgb&w=600',
  pro: 'https://images.pexels.com/photos/1871508/pexels-photo-1871508.jpeg?auto=compress&cs=tinysrgb&w=600',
};

const POKER_IMAGE_ROTATION = [
  'https://images.pexels.com/photos/1871508/pexels-photo-1871508.jpeg?auto=compress&cs=tinysrgb&w=600',
  'https://images.pexels.com/photos/3279691/pexels-photo-3279691.jpeg?auto=compress&cs=tinysrgb&w=600',
  'https://images.pexels.com/photos/6664248/pexels-photo-6664248.jpeg?auto=compress&cs=tinysrgb&w=600',
  'https://images.pexels.com/photos/4254890/pexels-photo-4254890.jpeg?auto=compress&cs=tinysrgb&w=600',
  'https://images.pexels.com/photos/4386366/pexels-photo-4386366.jpeg?auto=compress&cs=tinysrgb&w=600',
  'https://images.pexels.com/photos/4386331/pexels-photo-4386331.jpeg?auto=compress&cs=tinysrgb&w=600',
];
let rotationIndex = 0;

function getContextualFallbackImage(title: string): string {
  const lower = title.toLowerCase();
  for (const [keyword, image] of Object.entries(KEYWORD_IMAGES)) {
    if (lower.includes(keyword)) return image;
  }
  const fallback = POKER_IMAGE_ROTATION[rotationIndex % POKER_IMAGE_ROTATION.length] ?? POKER_IMAGE_ROTATION[0]!;
  rotationIndex++;
  return fallback;
}

// ── Fetch helpers ──────────────────────────────────────────────────────────
async function fetchWithUA(
  url: string,
  ua: string,
  extraTimeoutMs = 0,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CONFIG.REQUEST_TIMEOUT + extraTimeoutMs,
  );
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    return await response.text();
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

async function fetchPage(url: string): Promise<string | null> {
  return fetchWithUA(
    url,
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  );
}

async function fetchArticlePage(url: string): Promise<string | null> {
  const v = await fetchWithUA(
    url,
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  );
  return v ?? (await fetchPage(url));
}

async function fetchWithMobileUA(url: string): Promise<string | null> {
  return fetchWithUA(
    url,
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    5000,
  );
}

// ── Image proxy helpers ────────────────────────────────────────────────────
async function fetchOgImageViaProxy(url: string): Promise<string | null> {
  try {
    const proxyUrl = `https://api.microlink.io/?url=${encodeURIComponent(url)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
    const response = await fetch(proxyUrl, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = (await response.json()) as { data?: { image?: { url?: string } } };
    return data.data?.image?.url ?? null;
  } catch {
    return null;
  }
}

async function fetchOgImageViaNoEmbed(url: string): Promise<string | null> {
  try {
    const proxyUrl = `https://noembed.com/embed?url=${encodeURIComponent(url)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
    const response = await fetch(proxyUrl, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = (await response.json()) as { thumbnail_url?: string };
    const imageUrl = data.thumbnail_url;
    if (
      imageUrl &&
      (imageUrl.endsWith('.jpg') ||
        imageUrl.endsWith('.jpeg') ||
        imageUrl.endsWith('.png') ||
        imageUrl.endsWith('.webp') ||
        imageUrl.includes('images'))
    ) {
      return imageUrl;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchOgImageViaGoogleCache(url: string): Promise<string | null> {
  try {
    const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
    const response = await fetch(cacheUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html',
      },
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const html = await response.text();
    return extractArticleImage(html, url);
  } catch {
    return null;
  }
}

async function fastFailImageProxy(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  const timeoutPromise = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), CONFIG.IMAGE_PROXY_TIMEOUT),
  );

  const runProxy = async (proxyFn: (u: string) => Promise<string | null>): Promise<string> => {
    const res = await proxyFn(url);
    if (!res) throw new Error('Proxy returned null');
    return res;
  };

  const proxyRace = Promise.any([
    runProxy(fetchOgImageViaProxy),
    runProxy(fetchOgImageViaNoEmbed),
    runProxy(fetchOgImageViaGoogleCache),
  ]).catch(() => null);

  return Promise.race([proxyRace, timeoutPromise]);
}

async function extractCardPlayerImage(articleUrl: string | null | undefined): Promise<string | null> {
  if (!articleUrl) return null;
  const proxyImage = await fastFailImageProxy(articleUrl);
  if (proxyImage) return proxyImage;

  const idMatch = articleUrl.match(/poker-news\/(\d+)/);
  if (idMatch && idMatch[1]) {
    const articleId = idMatch[1];
    const candidateUrls = [
      `https://www.cardplayer.com/assets/poker-news/${articleId}/main_image.jpg`,
      `https://www.cardplayer.com/assets/poker-news/${articleId}/main.jpg`,
      `https://www.cardplayer.com/poker-news/${articleId}/image.jpg`,
    ];
    for (const candidateUrl of candidateUrls) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const response = await fetch(candidateUrl, {
          method: 'HEAD',
          signal: controller.signal,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        });
        clearTimeout(timeout);
        if (response.ok) {
          const contentType = response.headers.get('content-type') ?? '';
          if (contentType.startsWith('image/')) return candidateUrl;
        }
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

// ── HTML helpers ───────────────────────────────────────────────────────────
function cleanText(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveUrl(url: string | null | undefined, baseUrl: string): string | null {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/') && baseUrl) {
    try {
      const base = new URL(baseUrl);
      return base.origin + url;
    } catch {
      return url;
    }
  }
  return url;
}

function getImageFromTag(imgTag: string): string | null {
  let match = imgTag.match(/srcset=["']([^"']+)["']/i);
  if (match && match[1]) {
    const parts = match[1].split(',').map((s) => s.trim());
    const last = parts[parts.length - 1];
    const lastSrc = last ? last.split(' ')[0] : null;
    if (lastSrc && !lastSrc.includes('data:')) return lastSrc;
  }
  const tryAttr = (attr: string): string | null => {
    const m = imgTag.match(new RegExp(`${attr}=["']([^"']+)["']`, 'i'));
    if (m && m[1] && !m[1].includes('data:')) return m[1];
    return null;
  };
  return (
    tryAttr('data-src') ??
    tryAttr('data-lazy-src') ??
    tryAttr('data-original') ??
    tryAttr('data-lazy') ??
    tryAttr('src')
  );
}

function extractArticleImage(html: string | null | undefined, baseUrl = ''): string | null {
  if (!html) return null;

  let match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (!match) match = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (match && match[1]) return match[1].replace(/&amp;/g, '&');

  match = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
  if (!match) match = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  if (match && match[1]) return match[1].replace(/&amp;/g, '&');

  const jsonLdMatches = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const jsonLdMatch of jsonLdMatches) {
    try {
      if (!jsonLdMatch[1]) continue;
      const parsed = JSON.parse(jsonLdMatch[1]) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const raw of items) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        const image = item.image;
        if (image) {
          if (typeof image === 'string') return image;
          if (typeof image === 'object') {
            const ig = image as Record<string, unknown>;
            if (typeof ig.url === 'string') return ig.url;
            if (Array.isArray(image) && image[0]) {
              const first = image[0];
              if (typeof first === 'string') return first;
              if (typeof first === 'object' && first && typeof (first as Record<string, unknown>).url === 'string') {
                return (first as Record<string, unknown>).url as string;
              }
            }
          }
        }
        if (typeof item.thumbnailUrl === 'string') return item.thumbnailUrl;
      }
    } catch {
      /* skip non-JSON ld+json blocks */
    }
  }

  const featuredPatterns = [
    /<img[^>]+class=["'][^"']*(?:featured|hero|article-image|post-image|entry-image|main-image|wp-post-image|attachment-full|size-full|post-thumbnail)[^"']*["'][^>]*>/gi,
    /<figure[^>]*class=["'][^"']*(?:featured|hero|post-thumbnail|wp-block-image)[^"']*["'][^>]*>[\s\S]*?<img[^>]*>/gi,
  ];
  for (const pattern of featuredPatterns) {
    const matches = html.matchAll(pattern);
    for (const imgMatch of matches) {
      if (!imgMatch[0]) continue;
      const imgUrl = getImageFromTag(imgMatch[0]);
      if (imgUrl) return resolveUrl(imgUrl, baseUrl);
    }
  }

  const contentAreas = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<div[^>]+class=["'][^"']*(?:content|article|post|entry|story|news)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+id=["'][^"']*(?:content|article|post|entry|story|main)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const areaPattern of contentAreas) {
    const contentMatch = html.match(areaPattern);
    if (contentMatch && contentMatch[1]) {
      const imgMatches = contentMatch[1].matchAll(/<img[^>]+>/gi);
      for (const imgTag of imgMatches) {
        if (!imgTag[0]) continue;
        const imgUrl = getImageFromTag(imgTag[0]);
        if (
          imgUrl &&
          !imgUrl.includes('icon') &&
          !imgUrl.includes('logo') &&
          !imgUrl.includes('avatar')
        ) {
          return resolveUrl(imgUrl, baseUrl);
        }
      }
    }
  }

  const pictureMatch = html.match(/<picture[^>]*>[\s\S]*?<source[^>]+srcset=["']([^"']+)["']/i);
  if (pictureMatch && pictureMatch[1]) {
    const first = pictureMatch[1].split(',')[0];
    const src = first ? first.split(' ')[0] : null;
    if (src) return resolveUrl(src, baseUrl);
  }

  const allImages = html.matchAll(/<img[^>]+>/gi);
  for (const img of allImages) {
    if (!img[0]) continue;
    const imgUrl = getImageFromTag(img[0]);
    if (!imgUrl) continue;
    if (
      imgUrl.includes('icon') ||
      imgUrl.includes('logo') ||
      imgUrl.includes('avatar') ||
      imgUrl.includes('pixel') ||
      imgUrl.includes('tracking') ||
      imgUrl.includes('badge') ||
      imgUrl.includes('1x1') ||
      imgUrl.includes('spacer') ||
      imgUrl.includes('blank') ||
      imgUrl.includes('spinner') ||
      imgUrl.includes('loading') ||
      imgUrl.endsWith('.gif') ||
      imgUrl.includes('data:image') ||
      imgUrl.includes('gravatar') ||
      imgUrl.includes('emoji')
    ) {
      continue;
    }
    return resolveUrl(imgUrl, baseUrl);
  }

  return null;
}

function extractRssImage(item: Record<string, unknown>): string | null {
  const enclosure = item.enclosure as { url?: string; $?: { url?: string } } | undefined;
  if (enclosure?.url) return enclosure.url;
  if (enclosure?.$?.url) return enclosure.$.url;

  const mc = item['media:content'] as
    | { url?: string; $?: { url?: string } }
    | Array<{ url?: string; $?: { url?: string } }>
    | undefined;
  if (mc) {
    if (Array.isArray(mc)) {
      for (const m of mc) {
        if (m?.$?.url) return m.$.url;
        if (m?.url) return m.url;
      }
    } else {
      if (mc.$?.url) return mc.$.url;
      if (mc.url) return mc.url;
    }
  }

  const mt = item['media:thumbnail'] as
    | { url?: string; $?: { url?: string } }
    | Array<{ url?: string; $?: { url?: string } }>
    | undefined;
  if (mt) {
    if (Array.isArray(mt)) {
      for (const t of mt) {
        if (t?.$?.url) return t.$.url;
        if (t?.url) return t.url;
      }
    } else {
      if (mt.$?.url) return mt.$.url;
      if (mt.url) return mt.url;
    }
  }

  const mg = item['media:group'] as { 'media:content'?: { $?: { url?: string } } } | undefined;
  if (mg?.['media:content']?.$?.url) return mg['media:content'].$.url;

  const itimage = item['itunes:image'] as { $?: { href?: string } } | undefined;
  if (itimage?.$?.href) return itimage.$.href;

  const img = item.image as { url?: string } | string | undefined;
  if (img) {
    if (typeof img === 'string') return img;
    if (typeof img === 'object' && img.url) return img.url;
  }

  const ce = item['content:encoded'];
  if (typeof ce === 'string') {
    let m = ce.match(/<img[^>]+data-src=["']([^"']+)["']/i);
    if (m && m[1]) return m[1];
    m = ce.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m && m[1] && !m[1].includes('data:')) return m[1];
  }

  const desc = item.description;
  if (typeof desc === 'string') {
    let m = desc.match(/<img[^>]+data-src=["']([^"']+)["']/i);
    if (m && m[1]) return m[1];
    m = desc.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m && m[1] && !m[1].includes('data:')) return m[1];
  }

  const summary = item.summary;
  if (typeof summary === 'string') {
    const m = summary.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m && m[1] && !m[1].includes('data:')) return m[1];
  }

  return null;
}

// ── Per-source scrapers ────────────────────────────────────────────────────
async function scrapeRSS(source: NewsSource): Promise<Article[]> {
  const articles: Article[] = [];
  try {
    const feed = await rssParser.parseURL(source.url);
    const items = (feed.items ?? []).slice(0, CONFIG.MAX_ARTICLES_PER_SOURCE);
    for (const item of items) {
      const title = cleanText(item.title);
      if (!title || title.length < 10) continue;

      let image = extractRssImage(item as unknown as Record<string, unknown>);

      if (!image && item.link && source.name === 'CardPlayer') {
        image = await extractCardPlayerImage(item.link);
      }

      if (!image && item.link && source.name !== 'CardPlayer') {
        const articleHtml = await fetchArticlePage(item.link);
        image = extractArticleImage(articleHtml, item.link);
      }

      if (!image && item.link && source.name !== 'CardPlayer') {
        image = await fastFailImageProxy(item.link);
      }

      if (!image) image = getContextualFallbackImage(title);

      if (image && item.link) {
        const rawDate = item.isoDate ?? item.pubDate ?? null;
        let publishedAt: string | null = null;
        if (rawDate) {
          const parsed = Date.parse(rawDate);
          if (!Number.isNaN(parsed)) publishedAt = new Date(parsed).toISOString();
        }
        articles.push({ url: item.link, title, image, source, publishedAt });
      }
    }
  } catch (err) {
    console.warn('[news-scraper] RSS error:', err instanceof Error ? err.message : err);
  }
  return articles;
}

async function scrapeMSPT(html: string, source: NewsSource): Promise<Article[]> {
  const articles: Article[] = [];
  const seen = new Set<string>();

  const cardPattern =
    /class="thumb"\s*style="background-image:\s*url\('([^']+)'\)[^"]*"[\s\S]*?<h1>\s*<a\s+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi;
  for (const match of html.matchAll(cardPattern)) {
    if (articles.length >= CONFIG.MAX_ARTICLES_PER_SOURCE) break;
    let image = match[1]?.trim() ?? '';
    let url = match[2]?.trim() ?? '';
    const title = cleanText(match[3] ?? '');
    if (!title || title.length < 10) continue;
    if (!url || url.includes('javascript:') || url.includes('#')) continue;
    if (!url.startsWith('http')) {
      url = url.replace(/^\.\.\//, '').replace(/^\.\//, '').replace(/^\//, '');
      url = source.baseUrl + '/' + url;
    }
    if (image && !image.startsWith('http')) {
      image = source.baseUrl + '/' + image.replace(/^\//, '');
    }
    if (seen.has(url)) continue;
    seen.add(url);
    if (!image) image = getContextualFallbackImage(title);
    articles.push({ url, title, image, source });
  }

  if (articles.length === 0) {
    const linkPatterns = [
      /href=["']((?:\.\.\/)?Magazine\/[^"']+\.aspx)["'][^>]*>([^<]+)/gi,
      /href=["'](https?:\/\/(?:www\.)?msptpoker\.com\/Magazine\/[^"']+\.aspx)["'][^>]*>([^<]+)/gi,
    ];
    for (const pattern of linkPatterns) {
      if (articles.length >= CONFIG.MAX_ARTICLES_PER_SOURCE) break;
      for (const match of html.matchAll(pattern)) {
        if (articles.length >= CONFIG.MAX_ARTICLES_PER_SOURCE) break;
        let url = match[1] ?? '';
        const title = cleanText(match[2] ?? '');
        if (!title || title.length < 10 || seen.has(url)) continue;
        if (!url.startsWith('http')) {
          url = url.replace(/^\.\.\//, '').replace(/^\.\//, '').replace(/^\//, '');
          url = source.baseUrl + '/' + url;
        }
        if (seen.has(url)) continue;
        seen.add(url);
        const articleHtml = await fetchPage(url);
        let image = extractArticleImage(articleHtml, url);
        if (!image) image = getContextualFallbackImage(title);
        articles.push({ url, title, image, source });
      }
    }
  }

  return articles;
}

async function scrapeWSOP(html: string, source: NewsSource): Promise<Article[]> {
  const articles: Article[] = [];
  const seen = new Set<string>();
  const patterns = [
    /href=["']((?:https?:\/\/www\.wsop\.com)?\/news\/[^"']+)["'][^>]*>([^<]+)/gi,
    /href=["']((?:https?:\/\/www\.wsop\.com)?\/article\/[^"']+)["'][^>]*>([^<]+)/gi,
    /<h[23][^>]*>\s*<a[^>]+href=["']((?:https?:\/\/www\.wsop\.com)?\/[^"']+)["'][^>]*>([^<]+)/gi,
    /<div[^>]*class=["'][^"']*(?:card|article|news-item|post)[^"']*["'][^>]*>[\s\S]*?<a[^>]+href=["']((?:https?:\/\/www\.wsop\.com)?\/[^"']+)["'][^>]*>[\s\S]*?<[^>]*>([^<]{15,})/gi,
  ];
  for (const pattern of patterns) {
    if (articles.length >= CONFIG.MAX_ARTICLES_PER_SOURCE) break;
    for (const match of html.matchAll(pattern)) {
      if (articles.length >= CONFIG.MAX_ARTICLES_PER_SOURCE) break;
      let url = match[1] ?? '';
      const title = cleanText(match[2] ?? '');
      if (!title || title.length < 15 || seen.has(url)) continue;
      if (
        url.includes('/category/') ||
        url.includes('/tag/') ||
        url.includes('/author/') ||
        url.includes('#') ||
        url.includes('javascript:') ||
        url.includes('/players/') ||
        url.includes('/schedule/') ||
        url.includes('/circuit/')
      ) {
        continue;
      }
      if (!url.startsWith('http')) url = source.baseUrl + url;
      seen.add(url);
      const articleHtml = await fetchPage(url);
      let image = extractArticleImage(articleHtml, url);
      if (!image) image = getContextualFallbackImage(title);
      articles.push({ url, title, image, source });
    }
  }
  return articles;
}

async function scrapePokerfuse(html: string, source: NewsSource): Promise<Article[]> {
  const articles: Article[] = [];
  const seen = new Set<string>();
  const patterns = [
    /href=["']((?:https?:\/\/pokerfuse\.com)?\/latest-news\/\d{4}\/\d{1,2}\/[^"']+)["'][^>]*>([^<]+)/gi,
    /<h[23][^>]*>\s*<a[^>]+href=["']((?:https?:\/\/pokerfuse\.com)?\/latest-news\/\d{4}\/\d{1,2}\/[^"']+)["'][^>]*>([^<]+)/gi,
    /<a[^>]+href=["']((?:https?:\/\/pokerfuse\.com)?\/latest-news\/\d{4}\/\d{1,2}\/[^"']+)["'][^>]*>[\s\S]*?<[^>]*>([^<]{15,})/gi,
    /href=["']((?:https?:\/\/pokerfuse\.com)?\/(?:the-rail|live-poker)\/\d{4}\/\d{1,2}\/[^"']+)["'][^>]*>([^<]+)/gi,
  ];
  for (const pattern of patterns) {
    if (articles.length >= CONFIG.MAX_ARTICLES_PER_SOURCE) break;
    for (const match of html.matchAll(pattern)) {
      if (articles.length >= CONFIG.MAX_ARTICLES_PER_SOURCE) break;
      let url = match[1] ?? '';
      const title = cleanText(match[2] ?? '');
      if (!title || title.length < 15 || seen.has(url)) continue;
      if (
        title.toLowerCase().includes('read more') ||
        title.toLowerCase().includes('continue')
      ) {
        continue;
      }
      if (!url.startsWith('http')) url = source.baseUrl + url;
      seen.add(url);
      const articleHtml = await fetchPage(url);
      let image = extractArticleImage(articleHtml, url);
      if (!image) image = getContextualFallbackImage(title);
      articles.push({ url, title, image, source });
    }
  }
  return articles;
}

async function scrapeCardPlayer(html: string, source: NewsSource): Promise<Article[]> {
  const articles: Article[] = [];
  const seen = new Set<string>();
  const patterns = [
    /href=["']((?:https?:\/\/www\.cardplayer\.com)?\/poker-news\/\d+\/[^"']+)["'][^>]*>([^<]+)/gi,
    /href=["']((?:https?:\/\/www\.cardplayer\.com)?\/poker-news\/[^"'\/]+)["'][^>]*>([^<]+)/gi,
    /<a[^>]+href=["']((?:https?:\/\/www\.cardplayer\.com)?\/[^"']+)["'][^>]*>\s*<[^>]*>\s*([^<]{20,})/gi,
    /<h[23][^>]*>\s*<a[^>]+href=["']((?:https?:\/\/www\.cardplayer\.com)?\/[^"']+)["'][^>]*>([^<]+)/gi,
  ];
  for (const pattern of patterns) {
    if (articles.length >= CONFIG.MAX_ARTICLES_PER_SOURCE) break;
    for (const match of html.matchAll(pattern)) {
      if (articles.length >= CONFIG.MAX_ARTICLES_PER_SOURCE) break;
      let url = match[1] ?? '';
      const title = cleanText(match[2] ?? '');
      if (!title || title.length < 15 || seen.has(url)) continue;
      if (
        url.includes('/category/') ||
        url.includes('/tag/') ||
        url.includes('/author/') ||
        url.includes('#') ||
        url.includes('javascript:')
      ) {
        continue;
      }
      if (!url.startsWith('http')) url = source.baseUrl + url;
      seen.add(url);
      const articleHtml = await fetchPage(url);
      let image = extractArticleImage(articleHtml, url);
      if (!image) image = getContextualFallbackImage(title);
      articles.push({ url, title, image, source });
    }
  }
  return articles;
}

async function scrapePokerOrg(_html: string, source: NewsSource): Promise<Article[]> {
  const articles: Article[] = [];
  const seen = new Set<string>();
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  // In January the previous month is December of the PREVIOUS year — the old
  // `${year}-12` pointed at a sitemap that does not exist.
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const sitemapUrls = [
    `https://www.poker.org/sitemaps/article-${year}-${month}.xml`,
    `https://www.poker.org/sitemaps/article-${prevYear}-${prevMonth}.xml`,
  ];
  for (const sitemapUrl of sitemapUrls) {
    if (articles.length >= CONFIG.MAX_ARTICLES_PER_SOURCE) break;
    const sitemapXml = await fetchPage(sitemapUrl);
    if (!sitemapXml) continue;
    for (const match of sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/gi)) {
      if (articles.length >= CONFIG.MAX_ARTICLES_PER_SOURCE) break;
      const url = match[1];
      if (!url) continue;
      if (!url.includes('/latest-news/')) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      const urlPath = url.replace('https://www.poker.org', '').replace(/\/$/, '');
      const segments = urlPath.split('/');
      const slugWithId = segments[segments.length - 1] ?? '';
      const slug = slugWithId.replace(/-[a-zA-Z0-9]{10,}$/, '');
      const title = slug
        .split('-')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
        .slice(0, 100);
      if (!title || title.length < 15) continue;
      const articleHtml = await fetchPage(url);
      let image = extractArticleImage(articleHtml, url);
      if (!image) image = getContextualFallbackImage(title);
      articles.push({ url, title, image, source });
    }
  }
  return articles;
}

async function scrapePokerNewsVideos(html: string, source: NewsSource): Promise<Article[]> {
  const articles: Article[] = [];
  const seen = new Set<string>();
  const pattern = /href=["'](\/video\/[^"']+\.htm)["'][^>]*class=["']title["'][^>]*>([^<]+)/gi;
  for (const match of html.matchAll(pattern)) {
    if (articles.length >= CONFIG.MAX_ARTICLES_PER_SOURCE) break;
    let url = match[1] ?? '';
    let title = cleanText(match[2] ?? '');
    if (!title || title.length < 15 || seen.has(url)) continue;
    title = title.replace(/\s*\|\s*PokerNews.*$/i, '').trim();
    url = source.baseUrl + url;
    seen.add(url);
    const videoHtml = await fetchPage(url);
    let image = extractArticleImage(videoHtml, url);
    if (!image) image = getContextualFallbackImage(title);
    articles.push({ url, title: `🎬 ${title}`, image, source });
  }
  return articles;
}

async function scrapePokerNews(html: string, source: NewsSource): Promise<Article[]> {
  const articles: Article[] = [];
  const seen = new Set<string>();
  const patterns = [
    /href=["']((?:https?:\/\/www\.pokernews\.com)?\/news\/\d{4}\/\d{1,2}\/[^"']+)["'][^>]*>([^<]+)/gi,
    /<h[23][^>]*>\s*<a[^>]+href=["']((?:https?:\/\/www\.pokernews\.com)?\/news\/[^"']+)["'][^>]*>([^<]+)/gi,
    /<article[^>]*>[\s\S]*?<a[^>]+href=["']((?:https?:\/\/www\.pokernews\.com)?\/news\/[^"']+)["'][^>]*>[\s\S]*?<[^>]*>([^<]{15,})/gi,
  ];
  for (const pattern of patterns) {
    if (articles.length >= CONFIG.MAX_ARTICLES_PER_SOURCE) break;
    for (const match of html.matchAll(pattern)) {
      if (articles.length >= CONFIG.MAX_ARTICLES_PER_SOURCE) break;
      let url = match[1] ?? '';
      const title = cleanText(match[2] ?? '');
      if (!title || title.length < 15 || seen.has(url)) continue;
      if (url.includes('#') || url.includes('javascript:')) continue;
      if (!url.startsWith('http')) url = source.baseUrl + url;
      seen.add(url);
      const articleHtml = await fetchPage(url);
      let image = extractArticleImage(articleHtml, url);
      if (!image) image = getContextualFallbackImage(title);
      articles.push({ url, title, image, source });
    }
  }
  return articles;
}

async function scrapeSource(source: NewsSource): Promise<Article[]> {
  let articles: Article[] = [];

  if (source.type === 'rss') {
    articles = await scrapeRSS(source);
  } else if (source.type === 'hybrid') {
    articles = await scrapeRSS(source);
    if (articles.length === 0 && source.scrapeUrl) {
      const html = await fetchPage(source.scrapeUrl);
      if (html && source.name === 'PokerNews') {
        articles = await scrapePokerNews(html, source);
      }
    }
  } else {
    let html: string | null;
    if (source.name === 'MSPT') {
      html = await fetchWithMobileUA(source.url);
      if (!html) html = await fetchPage(source.url);
    } else {
      html = await fetchPage(source.url);
      if (!html) html = await fetchArticlePage(source.url);
    }
    if (!html) {
      if (source.name === 'MSPT') html = await fetchArticlePage(source.url);
      else html = await fetchWithMobileUA(source.url);
    }
    if (!html) return [];

    switch (source.name) {
      case 'MSPT':
        articles = await scrapeMSPT(html, source);
        break;
      case 'WSOP':
        articles = await scrapeWSOP(html, source);
        break;
      case 'Pokerfuse':
        articles = await scrapePokerfuse(html, source);
        break;
      case 'CardPlayer':
        articles = await scrapeCardPlayer(html, source);
        break;
      case 'Poker.org':
        articles = await scrapePokerOrg(html, source);
        break;
      default:
        break;
    }
  }

  return articles;
}

// ── DB operations ──────────────────────────────────────────────────────────
async function getNewsPosterId(): Promise<string | null> {
  const supabase = getSupabase();
  const { data: account } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('id', NEWS_POSTER_UUID)
    .maybeSingle();
  if (account) return (account as { id: string }).id;
  return null;
}

async function postToSocialFeed(article: Article, newsPosterId: string | null): Promise<void> {
  if (!newsPosterId) return;
  const supabase = getSupabase();

  const { data: existing } = await supabase
    .from('social_posts')
    .select('id')
    .like('content', `%${article.url}%`)
    .maybeSingle();
  if (existing) return;

  const sourceIcon = article.source.icon || '📰';
  const postContent = `${sourceIcon} **${article.title}**\n\nvia ${article.source.name}\n🔗 ${article.url}`;

  const { error } = await supabase.from('social_posts').insert({
    author_id: newsPosterId,
    content: postContent,
    content_type: 'link',
    media_urls: article.image ? [article.image] : [],
    visibility: 'public',
    metadata: {
      news_source: article.source.name,
      news_box: article.source.box,
      article_url: article.url,
      article_image: article.image,
    },
  });

  if (error) console.warn(`[news-scraper] social post error: ${error.message}`);
}

/**
 * Returns the saved row, or null when the upsert was suppressed as a duplicate.
 * (It used to return `data`, which is a truthy EMPTY array for duplicates —
 * inflating saved counts and permanently disabling the video fallback.)
 */
async function saveArticle(article: Article, newsPosterId: string | null): Promise<unknown> {
  const supabase = getSupabase();
  const slug = article.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 100);

  const { data, error } = await supabase
    .from('poker_news')
    .upsert(
      {
        title: article.title,
        slug: `${slug}-${Date.now()}`,
        content: '',
        excerpt: article.title.slice(0, 150),
        image_url: article.image,
        category: article.source.category,
        source_url: article.url,
        source_name: article.source.name,
        source_box: article.source.box,
        is_published: true,
        is_featured: false,
        views: 0,
        // Real publication date when the source gave us one — stamping scrape
        // time skewed the 3-day archive window.
        published_at: article.publishedAt ?? new Date().toISOString(),
      },
      { onConflict: 'source_url', ignoreDuplicates: true },
    )
    .select();

  const rows = (data ?? []) as Array<unknown>;
  const savedArticle = rows.length > 0 ? rows[0] : null;

  if (error && !error.message.includes('duplicate')) {
    console.warn(`[news-scraper] DB error: ${error.message}`);
    return null;
  }

  if (savedArticle) {
    await postToSocialFeed(article, newsPosterId);
  }

  return savedArticle;
}

async function archiveOldArticles(): Promise<number> {
  const supabase = getSupabase();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - CONFIG.RETENTION_DAYS);

  const { data, error } = await supabase
    .from('poker_news')
    .update({ is_archived: true })
    .lt('published_at', cutoffDate.toISOString())
    .eq('is_archived', false)
    .select('id');

  if (error) {
    console.warn('[news-scraper] archive error:', error.message);
    return 0;
  }

  return Array.isArray(data) ? data.length : 0;
}

// ── Handler ────────────────────────────────────────────────────────────────
interface SourceStats {
  found: number;
  saved: number;
  error?: string;
}

export async function newsScraper(c: Context) {
  const results: {
    sources: Record<string, SourceStats>;
    totalSaved: number;
    archived: number;
    errors: string[];
  } = {
    sources: {},
    totalSaved: 0,
    archived: 0,
    errors: [],
  };

  try {
    const newsPosterId = await getNewsPosterId();

    const sourceResults = await Promise.allSettled(
      NEWS_SOURCES.map(async (source) => {
        try {
          let articles = await scrapeSource(source);
          const sourceStats: SourceStats = { found: articles.length, saved: 0 };

          for (const article of articles) {
            const saved = await saveArticle(article, newsPosterId);
            if (saved) sourceStats.saved++;
          }

          if (
            source.name === 'PokerNews' &&
            source.videoUrl &&
            sourceStats.saved === 0
          ) {
            const videoHtml = await fetchPage(source.videoUrl);
            if (videoHtml) {
              const videoArticles = await scrapePokerNewsVideos(videoHtml, source);
              sourceStats.found += videoArticles.length;
              for (const video of videoArticles) {
                const saved = await saveArticle(video, newsPosterId);
                if (saved) sourceStats.saved++;
              }
            }
          }

          return { name: source.name, stats: sourceStats };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          throw { name: source.name, message: msg };
        }
      }),
    );

    for (const result of sourceResults) {
      if (result.status === 'fulfilled') {
        const { name, stats } = result.value;
        results.sources[name] = stats;
        results.totalSaved += stats.saved;
      } else {
        const reason = result.reason as { name?: string; message?: string };
        const name = reason?.name ?? 'unknown';
        const message = reason?.message ?? 'unknown error';
        results.sources[name] = { found: 0, saved: 0, error: message };
        results.errors.push(`${name}: ${message}`);
      }
    }

    results.archived = await archiveOldArticles();

    return c.json({
      success: true,
      timestamp: new Date().toISOString(),
      results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[news-scraper] fatal:', msg);
    return c.json({ success: false, error: msg, results }, 500);
  }
}
