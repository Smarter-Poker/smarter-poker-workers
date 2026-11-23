/**
 * GET/POST /cron/poker-news
 *
 * Ported from pages/api/cron/poker-news.js (376 lines).
 *
 * Hourly: pull RSS from PokerNews, CardPlayer, PokerListings, Poker.org;
 * pick the highest-priority article that hasn't been shared in the last
 * 6h and post it to social_posts as the system account, with a paired
 * row in poker_news (linked via social_post_id).
 *
 * Idempotence:
 *   - 6h cooldown via isArticleRecentlyShared() reading social_posts.content
 *     LIKE %link% AND poker_news.scraped_at >= now-6h
 *   - source_url-keyed dedupe in poker_news: an article already present in the
 *     archive is skipped entirely (never re-posted), regardless of its age
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import RssParser from 'rss-parser';
import { getSupabase } from '../lib/supabase.js';
import { extractArticleImageUrl } from '../lib/content-engine/NewsImage.js';
import { newsSources } from '../lib/content-engine/ClipSupply.js';

const SYSTEM_UUID = '00000000-0000-0000-0000-000000000001';

const CONFIG = {
  NEWS_COOLDOWN_HOURS: 6,
  MAX_SUMMARY_LENGTH: 200,
  FETCH_TIMEOUT_MS: 10_000,
} as const;

const FEED_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
};

interface NewsSource {
  name: string;
  rss: string;
  icon: string;
  priority: number;
}

/**
 * Fallback feeds used ONLY when `content_sources` is unreadable.
 * Uses the verified working XML RSS endpoints rather than dead/HTML URLs.
 */
const FALLBACK_NEWS_SOURCES: NewsSource[] = [
  { name: 'PokerNews', rss: 'https://www.pokernews.com/rss.php', icon: '🃏', priority: 1 },
  { name: 'CardPlayer', rss: 'https://www.cardplayer.com/poker-news.rss', icon: '♠️', priority: 2 },
];

const SOURCE_META: Record<string, { icon: string; priority: number }> = {
  pokernews: { icon: '🃏', priority: 1 },
  cardplayer: { icon: '♠️', priority: 2 },
  'poker.org': { icon: '♦️', priority: 3 },
  'upswing poker news': { icon: '♣️', priority: 4 },
};

interface Article {
  title: string;
  link: string;
  pubDate: Date;
  source: string;
  icon: string;
  priority: number;
  summary: string;
  category: 'tournament' | 'strategy' | 'industry' | 'news';
  imageUrl: string | null;
}

interface FetchNewsResult {
  articles: Article[];
  feedsAttempted: number;
  feedsSucceeded: number;
  feedErrors: Array<{ source: string; url: string; error: string }>;
}

const rssParser = new RssParser();

async function resolveNewsSources(): Promise<NewsSource[]> {
  const fromRegistry = await newsSources('poker');
  if (fromRegistry === null) return FALLBACK_NEWS_SOURCES;
  return fromRegistry.map((row, idx) => {
    const meta = SOURCE_META[row.name.toLowerCase()];
    return {
      name: row.name,
      rss: row.feed_url,
      icon: meta?.icon ?? '♠️',
      priority: meta?.priority ?? 10 + idx,
    };
  });
}

async function fetchFeedXml(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: FEED_HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    const head = body.trimStart().slice(0, 2048);
    if (/^(?:<!doctype\s+html|<html[\s>])/i.test(head) || !/<(?:rss|feed|rdf:RDF)[\s>]/i.test(head)) {
      throw new Error('response_not_xml_feed');
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function categorizeArticle(title: string): Article['category'] {
  const t = title.toLowerCase();
  if (t.includes('wsop') || t.includes('wpt') || t.includes('tournament')) return 'tournament';
  if (t.includes('strategy') || t.includes('how to') || t.includes('tips')) return 'strategy';
  if (t.includes('poker room') || t.includes('casino') || t.includes('online')) return 'industry';
  return 'news';
}

async function fetchLatestNews(): Promise<FetchNewsResult> {
  const sources = await resolveNewsSources();
  const all: Article[] = [];
  const feedErrors: Array<{ source: string; url: string; error: string }> = [];
  let feedsSucceeded = 0;

  for (const source of sources) {
    try {
      const xml = await fetchFeedXml(source.rss);
      const feed = await rssParser.parseString(xml);
      feedsSucceeded++;
      const items = (feed.items || []).slice(0, 5);
      for (const item of items) {
        if (!item.title || !item.link) continue;
        const raw = item as unknown as Record<string, unknown>;
        const imageUrl = extractArticleImageUrl(raw);
        const summary = ((item.contentSnippet || item.content || '') as string).slice(
          0,
          CONFIG.MAX_SUMMARY_LENGTH,
        );
        const parsedDate = new Date(item.pubDate || item.isoDate || Date.now());
        const pubDate = Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
        all.push({
          title: item.title,
          link: item.link,
          pubDate,
          source: source.name,
          icon: source.icon,
          priority: source.priority,
          summary,
          category: categorizeArticle(item.title),
          imageUrl,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      feedErrors.push({ source: source.name, url: source.rss, error: msg });
      console.warn(`[poker-news] error fetching ${source.name}:`, msg);
    }
  }

  const articles = all.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.pubDate.getTime() - a.pubDate.getTime();
  });

  return {
    articles,
    feedsAttempted: sources.length,
    feedsSucceeded,
    feedErrors,
  };
}

async function isArticleRecentlyShared(link: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - CONFIG.NEWS_COOLDOWN_HOURS * 60 * 60 * 1000);
  const supabase = getSupabase();

  const { data: socialData } = await supabase
    .from('social_posts')
    .select('id')
    .ilike('content', `%${link}%`)
    .gte('created_at', cutoff.toISOString())
    .limit(1);

  if (socialData && socialData.length > 0) return true;

  const { data: newsData } = await supabase
    .from('poker_news')
    .select('id')
    .eq('source_url', link)
    .gte('scraped_at', cutoff.toISOString())
    .limit(1);

  return !!(newsData && newsData.length > 0);
}

interface ArchiveResult {
  id: string;
  existed: boolean;
}

async function saveToNewsArchive(article: Article): Promise<ArchiveResult | null> {
  const supabase = getSupabase();

  const { data: existing } = await supabase
    .from('poker_news')
    .select('id')
    .eq('source_url', article.link)
    .maybeSingle();

  if (existing) return { id: (existing as { id: string }).id, existed: true };

  const { data: newsRecord, error } = await supabase
    .from('poker_news')
    .insert({
      title: article.title,
      summary: article.summary,
      excerpt: article.summary.slice(0, 150),
      source_name: article.source,
      source_url: article.link,
      source_icon: article.icon,
      image_url: article.imageUrl,
      category: article.category,
      tags: [article.category, article.source.toLowerCase()],
      published_at: article.pubDate.toISOString(),
      // Explicit — the 6h cooldown check reads scraped_at and must not depend
      // on a column default being present.
      scraped_at: new Date().toISOString(),
    })
    .select()
    .maybeSingle();

  if (error || !newsRecord) {
    console.warn('[poker-news] archive error:', error?.message ?? 'no data');
    return null;
  }
  return { id: (newsRecord as { id: string }).id, existed: false };
}

interface PostResult {
  post_id: string;
  method: 'rpc' | 'direct';
  has_image: boolean;
  news_id?: string | null;
}

async function postNewsArticle(article: Article, newsId: string | null): Promise<PostResult | null> {
  const supabase = getSupabase();
  const postContent = `${article.title}\n\nvia ${article.source}\n${article.link}`;
  const mediaUrls = article.imageUrl ? [article.imageUrl] : [];

  try {
    const { data: post, error: rpcError } = await supabase.rpc('fn_create_social_post', {
      p_author_id: SYSTEM_UUID,
      p_content: postContent,
      p_content_type: 'link',
      p_media_urls: mediaUrls,
      p_visibility: 'public',
      p_achievement_data: {
        article_url: article.link,
        article_source: article.source,
        article_title: article.title,
      },
    });

    if (rpcError) {
      const { data: directPost, error: directError } = await supabase
        .from('social_posts')
        .insert({
          author_id: SYSTEM_UUID,
          content: postContent,
          content_type: 'link',
          link_url: article.link,
          link_title: article.title,
          link_site_name: article.source,
          media_urls: mediaUrls,
          visibility: 'public',
          created_at: new Date().toISOString(),
        })
        .select()
        .maybeSingle();

      if (directError || !directPost) {
        throw directError ?? new Error('No data returned from insert');
      }
      return {
        post_id: (directPost as { id: string }).id,
        method: 'direct',
        has_image: !!article.imageUrl,
      };
    }

    const postRow = post as { id: string } | null;
    if (newsId && postRow?.id) {
      await supabase.from('poker_news').update({ social_post_id: postRow.id }).eq('id', newsId);
    }

    return {
      post_id: postRow?.id ?? 'created',
      method: 'rpc',
      has_image: !!article.imageUrl,
      news_id: newsId,
    };
  } catch (error) {
    console.warn('[poker-news] post error:', error instanceof Error ? error.message : error);
    return null;
  }
}

export async function pokerNews(c: Context) {
  try {
    const { articles, feedsAttempted, feedsSucceeded, feedErrors } = await fetchLatestNews();

    if (feedsAttempted > 0 && feedsSucceeded === 0) {
      return c.json(
        {
          success: false,
          error: 'all_news_feeds_failed',
          feeds_attempted: feedsAttempted,
          feeds_succeeded: feedsSucceeded,
          feed_errors: feedErrors,
          posted: 0,
        },
        503,
      );
    }

    if (articles.length === 0) {
      return c.json({
        success: true,
        message: 'No news available',
        feeds_attempted: feedsAttempted,
        feeds_succeeded: feedsSucceeded,
        posted: 0,
      });
    }

    let posted: PostResult | null = null;

    for (const article of articles) {
      const recentlyShared = await isArticleRecentlyShared(article.link);
      if (recentlyShared) continue;

      const archived = await saveToNewsArchive(article);
      if (!archived) continue;

      // Already in the archive — it has been posted before. The 6h cooldown
      // only looks at recency, so an article that sits atop a feed overnight
      // used to get a fresh duplicate social post every cycle. Reposting is an
      // explicit re-share feature, not a side effect of scraping.
      if (archived.existed) continue;

      posted = await postNewsArticle(article, archived.id);
      if (posted) break;
    }

    if (!posted) {
      return c.json({
        success: true,
        message: 'All articles recently shared',
        feeds_attempted: feedsAttempted,
        feeds_succeeded: feedsSucceeded,
        posted: 0,
      });
    }

    return c.json({
      success: true,
      posted: 1,
      post_id: posted.post_id,
      news_id: posted.news_id,
      method: posted.method,
      has_image: posted.has_image,
      feeds_attempted: feedsAttempted,
      feeds_succeeded: feedsSucceeded,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[poker-news] fatal:', msg);
    return c.json({ success: false, error: msg }, 500);
  }
}
