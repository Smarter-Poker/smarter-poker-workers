import { safeArticleUrl } from './NewsImage.js';

export interface NewsFeedCandidate {
  name: string;
  rss: string;
  fallback_urls?: string[] | null;
}

/** Original-request failover across configured feeds, never a repair loop. */
export function orderedNewsSources(
  sources: readonly NewsFeedCandidate[],
  preferredIndex: number,
  maximum = 6,
): Array<{ name: string; rss: string }> {
  if (!sources.length) return [];
  const start = ((Math.trunc(preferredIndex) % sources.length) + sources.length) % sources.length;
  const ordered = [...sources.slice(start), ...sources.slice(0, start)];
  const limit = Number.isFinite(maximum) ? Math.min(6, Math.max(0, Math.trunc(maximum))) : 6;
  const result: Array<{ name: string; rss: string }> = [];
  const seen = new Set<string>();
  const add = (name: string, value: unknown) => {
    const rss = safeArticleUrl(value);
    if (!rss || seen.has(rss) || result.length >= limit) return;
    seen.add(rss);
    result.push({ name, rss });
  };
  // Prefer independent publishers before retrying another endpoint of the
  // publisher that just returned 429. Existing fetchFeed caches refusals.
  for (const source of ordered) add(source.name, source.rss);
  for (const source of ordered) for (const rss of source.fallback_urls ?? []) add(source.name, rss);
  return result;
}
