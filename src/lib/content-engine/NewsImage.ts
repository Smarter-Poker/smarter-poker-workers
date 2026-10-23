/**
 * Extract the per-article image already carried by common RSS shapes.
 * This never fetches arbitrary page HTML. It accepts only ordinary web URLs
 * and refuses publisher chrome that would misrepresent a logo as story art.
 */
const GENERIC_ARTWORK = /(?:^|[\/_-])(?:favicon|logos?|placeholder|default|avatar|sprite|emoji|smiley|smilies|icon)(?:[\/_\-.]|$)/i;

export function safeArticleUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function safeArticleImageUrl(value: unknown): string | null {
  const safe = safeArticleUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  let decoded = safe;
  for (let i = 0; i < 2; i++) { try { decoded = decodeURIComponent(decoded); } catch { break; } }
  // ESPN's default share card contains no story photograph and its filename
  // omits "logo". It must not masquerade as article-specific artwork.
  return GENERIC_ARTWORK.test(decoded)
    // Observed in three different Upswing RSS stories: this identical
    // membership promotion is publisher chrome, not any article's artwork.
    || /on[-_]page[-_]banner[-_]main[-_]members/i.test(decoded)
    || /(?:^|\/)espn(?:[-_](?:combiner|default|share|og))?\.(?:png|jpe?g|webp)$/i.test(url.pathname)
    || /\/i\/espn\/espn_logos\//i.test(url.pathname)
    || /\/combiner\/i\?/.test(safe) && /(?:logo|espn_default)/i.test(url.search)
    ? null : safe;
}

const storyImageCache = new Map<string, { expires: number; pending: Promise<string | null> }>();
export function _resetArticleImageCache(): void { storyImageCache.clear(); }

/** Exact first-party story lookup only. No arbitrary article-page fetch/SSRF. */
export async function resolveArticleImageUrl(item: Record<string, unknown>): Promise<string | null> {
  const supplied = extractArticleImageUrl(item);
  if (supplied) return supplied;
  const link = safeArticleUrl(item.link);
  if (!link) return null;
  const url = new URL(link);
  const espn = ['espn.com', 'www.espn.com'].includes(url.hostname.toLowerCase());
  const id = espn ? url.pathname.match(/\/story\/_\/id\/(\d+)(?:\/|$)/)?.[1] : undefined;
  const cardPlayer = url.protocol === 'https:' && !url.port
    && url.hostname === 'www.cardplayer.com'
    && /^\/poker-news\/\d+-[a-z0-9-]+\/?$/i.test(url.pathname);
  const upswing = url.protocol === 'https:' && !url.port
    && url.hostname === 'upswingpoker.com'
    && /^\/[a-z0-9][a-z0-9-]{2,159}\/?$/i.test(url.pathname);
  if (!id && !cardPlayer && !upswing) return null;
  const cacheKey = id ? `espn:${id}` : `${url.hostname}:${url.pathname}`;
  const cached = storyImageCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.pending;
  const entry = { expires: Date.now() + 6000, pending: id ? fetchStoryImage(id) : fetchPublicArticleImage(url) };
  storyImageCache.set(cacheKey, entry);
  if (storyImageCache.size > 256) storyImageCache.delete(storyImageCache.keys().next().value!);
  const result = await entry.pending;
  // Success and failure are bounded metadata optimizations, never a publish
  // authority. An outage is retried on a later original request, not a timer.
  entry.expires = Date.now() + (result ? 5 * 60_000 : 30_000);
  return result;
}

function htmlAttribute(tag: string, name: string): string | null {
  const value = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2];
  return value?.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'") ?? null;
}

/** Fixed qualified public story origins, exact canonical identity, no redirects. */
async function fetchPublicArticleImage(url: URL): Promise<string | null> {
  try {
    const target = new URL(url.pathname, url.hostname === 'upswingpoker.com'
      ? 'https://upswingpoker.com' : 'https://www.cardplayer.com');
    const response = await fetch(target.href, {
      headers: { Accept: 'text/html' }, redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !/text\/html/i.test(response.headers.get('content-type') ?? '')) return null;
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 524_288) { await reader.cancel(); return null; }
      chunks.push(part.value);
    }
    const body = Buffer.concat(chunks, bytes).toString('utf8');
    const tags = [...body.matchAll(/<meta\b[^>]*>/gi)].map(match => match[0]);
    const metadata = (property: string) => tags.find(tag => htmlAttribute(tag, 'property')?.toLowerCase() === property);
    const canonical = safeArticleUrl(htmlAttribute(metadata('og:url') ?? '', 'content'));
    if (!canonical) return null;
    const identity = new URL(canonical);
    if (identity.origin !== target.origin || identity.pathname.replace(/\/$/, '') !== target.pathname.replace(/\/$/, '')) return null;
    return safeArticleImageUrl(htmlAttribute(metadata('og:image') ?? '', 'content'));
  } catch { return null; }
}

async function fetchStoryImage(id: string): Promise<string | null> {
  try {
    const response = await fetch(`https://content.core.api.espn.com/v1/sports/news/${id}`, {
      headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 262_144) { await reader.cancel(); return null; }
      chunks.push(part.value);
    }
    const body = Buffer.concat(chunks, bytes).toString('utf8');
    const data = JSON.parse(body) as { headlines?: Array<{ id?: string | number; images?: Array<{ url?: unknown }> }> };
    const story = data.headlines?.find(row=>String(row.id)===id);
    if (!story) return null;
    for (const image of story.images ?? []) {
      const safe = safeArticleImageUrl(image.url);
      if (safe) return safe;
    }
  } catch { /* A failed first-party resolution is no proof of story artwork. */ }
  return null;
}

function imageFromHtml(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const images = value.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi);
  for (const match of images) {
    const safe = safeArticleImageUrl(match[1]);
    if (safe) return safe;
  }
  return null;
}

export function extractArticleImageUrl(item: Record<string, unknown>): string | null {
  const enclosure = item.enclosure as { url?: unknown } | undefined;
  const mediaImage = (value: unknown): string | null => {
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (!entry || typeof entry !== 'object') continue;
      const safe = safeArticleImageUrl((entry as { $?: { url?: unknown } }).$?.url);
      if (safe) return safe;
    }
    return null;
  };
  return safeArticleImageUrl(enclosure?.url)
    ?? mediaImage(item['media:content'])
    ?? mediaImage(item['media:thumbnail'])
    ?? imageFromHtml(item['content:encoded'])
    // rss-parser normalizes RSS description into content. PokerNews carries
    // genuine story art here, not in the raw description key.
    ?? imageFromHtml(item.content)
    ?? imageFromHtml(item.description);
}
