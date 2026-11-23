/**
 * GET/POST /cron/content-health-check
 *
 * Ported from pages/api/cron/content-health-check.js (199 lines).
 *
 * Daily 6am: check 7 content-source RSS/HTML URLs for liveness.
 * If primary fails, try each fallback URL; on fix, log to system_logs.
 * If no fallback recovers, retain the failure in the response and local logs.
 *
 * Stateless check — no persistent state. Safe to run twice concurrently
 * (both would do the same fetches; only side effect is a system_logs
 * row per auto-fix, which is idempotent by content).
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

interface Source {
  name: string;
  kind: 'rss' | 'html';
  primary: string;
  fallbacks: string[];
}

const SOURCES: Source[] = [
  {
    name: 'PokerNews',
    kind: 'rss',
    primary: 'https://www.pokernews.com/rss.php',
    fallbacks: ['https://www.pokernews.com/news.rss'],
  },
  {
    name: 'MSPT',
    kind: 'html',
    primary: 'https://msptpoker.com/pages/Magazine.aspx',
    fallbacks: ['https://msptpoker.com/'],
  },
  {
    name: 'CardPlayer',
    kind: 'rss',
    primary: 'https://www.cardplayer.com/poker-news.rss',
    fallbacks: ['https://www.cardplayer.com/rss/news.xml'],
  },
  {
    name: 'WSOP',
    kind: 'html',
    primary: 'https://www.wsop.com/news/',
    fallbacks: ['https://www.wsop.com/'],
  },
  {
    name: 'Poker.org',
    kind: 'rss',
    primary: 'https://www.poker.org/feed',
    fallbacks: [],
  },
  {
    name: 'Pokerfuse',
    kind: 'html',
    primary: 'https://pokerfuse.com/',
    fallbacks: ['https://pokerfuse.com/latest-news/'],
  },
  {
    name: 'PokerNews Videos (YouTube)',
    kind: 'rss',
    primary: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCSu1ww_wgD0XD66C1ESrIGQ',
    fallbacks: [],
  },
];

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,text/html;q=0.8,*/*;q=0.7',
};

export function isValidFeedBody(body: string): boolean {
  const head = body.trimStart().slice(0, 2048);
  if (!head) return false;
  if (/^(?:<!doctype\s+html|<html[\s>])/i.test(head)) return false;
  return /<(?:rss|feed|rdf:RDF)[\s>]/i.test(head);
}

async function checkSource(
  url: string,
  kind: Source['kind'],
): Promise<{ ok: boolean; status: number; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (res.status !== 200) {
      return { ok: false, status: res.status };
    }
    if (kind === 'rss') {
      const body = typeof res.text === 'function' ? await res.text() : '';
      if (!isValidFeedBody(body)) {
        return { ok: false, status: res.status, error: 'not_valid_xml_feed' };
      }
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Try each fallback and, when one answers with a valid document of the same
 * kind (RSS feeds must return real XML, never an HTML homepage), switch the
 * registry row to it. Only report `applied: true` when an active registry row
 * was actually updated.
 */
async function tryFallbacks(
  source: Source,
  configPath: string,
): Promise<{ fixed: boolean; new_url?: string; applied: boolean }> {
  const supabase = getSupabase();
  for (const fallback of source.fallbacks) {
    const result = await checkSource(fallback, source.kind);
    if (!result.ok) continue;

    let applied = false;
    let rowsUpdated = 0;
    if (source.kind === 'rss') {
      const { error: upErr, count } = await supabase
        .from('content_sources')
        .update({ feed_url: fallback, updated_at: new Date().toISOString() }, { count: 'exact' })
        .eq('kind', 'rss')
        .eq('feed_url', source.primary);
      rowsUpdated = count ?? 0;
      applied = !upErr && rowsUpdated > 0;
      if (upErr) console.warn('[content-health] could not apply the fallback:', upErr.message);
    }

    await supabase.from('system_logs').insert({
      type: 'content_health_autofix',
      message: applied
        ? `${source.name}: switched from ${source.primary} to ${fallback}`
        : `${source.name}: ${fallback} works, but no registry row pointed at ${source.primary}`,
      metadata: {
        source: source.name,
        old_url: source.primary,
        new_url: fallback,
        config_path: configPath,
        auto_fixed: applied,
        rows_updated: rowsUpdated,
      },
    });
    return { fixed: true, new_url: fallback, applied };
  }
  return { fixed: false, applied: false };
}

export async function contentHealthCheck(c: Context) {
  const results: {
    timestamp: string;
    sources: Array<{ name: string; status: string; new_url?: string }>;
    healthy: number;
    failed: number;
    auto_fixed: number;
    needs_attention: string[];
  } = {
    timestamp: new Date().toISOString(),
    sources: [],
    healthy: 0,
    failed: 0,
    auto_fixed: 0,
    needs_attention: [],
  };

  for (const source of SOURCES) {
    const check = await checkSource(source.primary, source.kind);
    if (check.ok) {
      results.sources.push({ name: source.name, status: 'healthy' });
      results.healthy++;
    } else if (source.fallbacks.length > 0) {
      const fix = await tryFallbacks(source, 'pages/api/cron/news-scraper.js');
      if (fix.fixed && fix.applied) {
        results.sources.push({ name: source.name, status: 'auto_fixed', new_url: fix.new_url });
        results.auto_fixed++;
      } else if (fix.fixed && !fix.applied) {
        results.sources.push({
          name: source.name,
          status: 'fallback_not_applied',
          new_url: fix.new_url,
        });
        results.failed++;
        results.needs_attention.push(source.name);
      } else {
        results.sources.push({ name: source.name, status: 'failed' });
        results.failed++;
        results.needs_attention.push(source.name);
      }
    } else {
      results.sources.push({ name: source.name, status: 'failed' });
      results.failed++;
      results.needs_attention.push(source.name);
    }
  }

  if (results.needs_attention.length > 0) {
    try {
      console.warn(
        `[content-health-check] ${results.needs_attention.length} sources need manual attention`,
        { failed_sources: results.needs_attention, full_results: results },
      );
    } catch {
      // A failed log sink must not replace the actual source-health result.
    }
  }

  return c.json({ success: results.failed === 0, ...results });
}
