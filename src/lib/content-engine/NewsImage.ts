/**
 * Extract the per-article image already carried by common RSS shapes.
 * This never fetches arbitrary page HTML. It accepts only ordinary web URLs
 * and refuses publisher chrome that would misrepresent a logo as story art.
 */
const GENERIC_ARTWORK = /(?:^|[\/_-])(?:favicon|logo|placeholder|default|avatar|sprite)(?:[\/_\-.]|$)/i;

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

function safeArticleImageUrl(value: unknown): string | null {
  const safe = safeArticleUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  return GENERIC_ARTWORK.test(`${url.hostname}${url.pathname}`) ? null : safe;
}

function imageFromHtml(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
  return safeArticleImageUrl(match?.[1]);
}

export function extractArticleImageUrl(item: Record<string, unknown>): string | null {
  const enclosure = item.enclosure as { url?: unknown } | undefined;
  const media = item['media:content'] as { $?: { url?: unknown } } | undefined;
  const thumbnail = item['media:thumbnail'] as { $?: { url?: unknown } } | undefined;
  return safeArticleImageUrl(enclosure?.url)
    ?? safeArticleImageUrl(media?.$?.url)
    ?? safeArticleImageUrl(thumbnail?.$?.url)
    ?? imageFromHtml(item['content:encoded'])
    ?? imageFromHtml(item.description);
}
