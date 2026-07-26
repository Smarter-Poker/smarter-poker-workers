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

const SYSTEM_UUID = '00000000-0000-0000-0000-000000000001';

const CONFIG = {
  NEWS_COOLDOWN_HOURS: 6,
  MAX_SUMMARY_LENGTH: 200,
} as const;

interface NewsSource {
  name: string;
  rss: string;
  icon: string;
  priority: number;
}

const NEWS_SOURCES: NewsSource[] = [
  { name: 'PokerNews', rss: 'https://www.pokernews.com/news.rss', icon: '🃏', priority: 1 },
  { name: 'CardPlayer', rss: 'https://www.cardplayer.com/poker-news/rss', icon: '♠️', priority: 2 },
  { name: 'PokerListings', rss: 'https://www.pokerlistings.com/feed', icon: '🃏', priority: 3 },
  { name: 'Poker.org', rss: 'https://www.poker.org/feed/', icon: '♦️', priority: 4 },
];

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

const rssParser = new RssParser();

function categorizeArticle(title: string): Article['category'] {
  const t = title.toLowerCase();
  if (t.includes('wsop') || t.includes('wpt') || t.includes('tournament')) return 'tournament';
  if (t.includes('strategy') || t.includes('how to') || t.includes('tips')) return 'strategy';
  if (t.includes('poker room') || t.includes('casino') || t.includes('online')) return 'industry';
  return 'news';
}

function extractImageUrl(item: Record<string, unknown>): string | null {
  const enclosure = item.enclosure as { url?: string } | undefined;
  if (enclosure?.url) return enclosure.url;

  const mc = item['media:content'] as { $?: { url?: string } } | undefined;
  if (mc?.$?.url) return mc.$.url;

  const mt = item['media:thumbnail'] as { $?: { url?: string } } | undefined;
  if (mt?.$?.url) return mt.$.url;

  const ce = item['content:encoded'];
  if (typeof ce === 'string') {
    const m = ce.match(/<img[^>]+src="([^">]+)"/);
    if (m && m[1]) return m[1];
  }

  const desc = item.description;
  if (typeof desc === 'string') {
    const m = desc.match(/<img[^>]+src="([^">]+)"/);
    if (m && m[1]) return m[1];
  }

  return null;
}

async function fetchLatestNews(): Promise<Article[]> {
  const all: Article[] = [];

  for (const source of NEWS_SOURCES) {
    try {
      const feed = await rssParser.parseURL(source.rss);
      const items = (feed.items || []).slice(0, 5);
      for (const item of items) {
        if (!item.title || !item.link) continue;
        const raw = item as unknown as Record<string, unknown>;
        const imageUrl = extractImageUrl(raw);
        const summary = ((item.contentSnippet || item.content || '') as string).slice(
          0,
          CONFIG.MAX_SUMMARY_LENGTH,
        );
        all.push({
          title: item.title,
          link: item.link,
          pubDate: new Date(item.pubDate || item.isoDate || Date.now()),
          source: source.name,
          icon: source.icon,
          priority: source.priority,
          summary,
          category: categorizeArticle(item.title),
          imageUrl,
        });
      }
    } catch (err) {
      console.warn(
        `[poker-news] error fetching ${source.name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return all.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.pubDate.getTime() - a.pubDate.getTime();
  });
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
    const articles = await fetchLatestNews();

    if (articles.length === 0) {
      return c.json({ success: true, message: 'No news available', posted: 0 });
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
      return c.json({ success: true, message: 'All articles recently shared', posted: 0 });
    }

    return c.json({
      success: true,
      posted: 1,
      post_id: posted.post_id,
      news_id: posted.news_id,
      method: posted.method,
      has_image: posted.has_image,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[poker-news] fatal:', msg);
    return c.json({ success: false, error: msg }, 500);
  }
}
