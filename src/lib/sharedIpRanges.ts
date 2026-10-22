/**
 * Published shared-address lists for the multi-account detector (2026-10-22).
 *
 * Addresses that many unrelated people share (iCloud Private Relay, cloud
 * datacenters, GitHub runners) prove nothing about multiple accounts. Each
 * provider publishes its list; this keeps public.anti_cheat_shared_ip_ranges
 * current from those lists so nobody has to maintain them by hand.
 *
 * Rules:
 *  - one stale source per call, oldest first, so a cron run stays bounded;
 *  - a source refreshes at most weekly;
 *  - a failed or implausibly small download leaves the previous list alone;
 *  - IPv4 only (the detector only matches IPv4).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export const REFRESH_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const CHUNK = 5000;
const FETCH_TIMEOUT_MS = 30_000;
const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/(\d{1,2}))?$/;

export interface SharedIpSource {
  source: string;
  label: string;
  /** Fewer ranges than this means the download is broken, not the list. */
  minRanges: number;
  load: (fetchText: (url: string) => Promise<string>) => Promise<string[]>;
}

/** Normalise to a.b.c.d/n, IPv4 only. Exported for tests. */
export function toIpv4Cidr(raw: string): string | null {
  const m = IPV4_CIDR.exec(raw.trim());
  if (!m) return null;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  if (octets.some((o) => o > 255)) return null;
  const bits = m[6] === undefined ? 32 : Number(m[6]);
  if (bits < 1 || bits > 32) return null;
  return `${octets.join('.')}/${bits}`;
}

function uniqueV4(values: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const v of values) {
    const c = toIpv4Cidr(v);
    if (c) out.add(c);
  }
  return [...out];
}

/** Apple's egress CSV: "cidr,country,region,city," per line. Exported for tests. */
export function parseAppleEgressCsv(text: string): string[] {
  return uniqueV4(text.split('\n').map((line) => line.split(',')[0] ?? ''));
}

export const SHARED_IP_SOURCES: SharedIpSource[] = [
  {
    source: 'apple_private_relay',
    label: 'iCloud Private Relay (Apple published)',
    minRanges: 1000,
    load: async (get) => parseAppleEgressCsv(await get('https://mask-api.icloud.com/egress-ip-ranges.csv')),
  },
  {
    source: 'aws',
    label: 'Amazon AWS (published)',
    minRanges: 1000,
    load: async (get) => {
      const j = JSON.parse(await get('https://ip-ranges.amazonaws.com/ip-ranges.json')) as {
        prefixes?: Array<{ ip_prefix?: string }>;
      };
      return uniqueV4((j.prefixes ?? []).map((p) => p.ip_prefix ?? ''));
    },
  },
  {
    source: 'google_cloud',
    label: 'Google Cloud (published)',
    minRanges: 100,
    load: async (get) => {
      const j = JSON.parse(await get('https://www.gstatic.com/ipranges/cloud.json')) as {
        prefixes?: Array<{ ipv4Prefix?: string }>;
      };
      return uniqueV4((j.prefixes ?? []).map((p) => p.ipv4Prefix ?? ''));
    },
  },
  {
    source: 'cloudflare',
    label: 'Cloudflare (published)',
    minRanges: 5,
    load: async (get) => uniqueV4((await get('https://www.cloudflare.com/ips-v4')).split('\n')),
  },
  {
    source: 'github_actions',
    label: 'GitHub Actions runners (published)',
    minRanges: 100,
    load: async (get) => {
      const j = JSON.parse(await get('https://api.github.com/meta')) as { actions?: string[] };
      return uniqueV4(j.actions ?? []);
    },
  },
  {
    source: 'azure',
    label: 'Microsoft Azure (published)',
    minRanges: 1000,
    load: async (get) => {
      const page = await get('https://www.microsoft.com/en-us/download/details.aspx?id=56519');
      const link = /https:\/\/download\.microsoft\.com\/[^"'\s]+ServiceTags_Public_\d+\.json/.exec(page)?.[0];
      if (!link) throw new Error('Azure service tags link not found on the download page');
      const j = JSON.parse(await get(link)) as {
        values?: Array<{ name?: string; properties?: { addressPrefixes?: string[] } }>;
      };
      const cloud = (j.values ?? []).find((v) => v.name === 'AzureCloud');
      return uniqueV4(cloud?.properties?.addressPrefixes ?? []);
    },
  },
];

async function defaultFetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'smarter-poker-workers/anti-cheat (+https://smarter.poker)' },
    });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export interface RefreshOutcome {
  source: string | null;
  ranges?: number;
  skipped?: string;
  error?: string;
}

/** Refresh the stalest source that is due, if any. Never throws. */
export async function refreshOneStaleSource(
  supabase: SupabaseClient,
  opts: {
    now?: Date;
    fetchText?: (url: string) => Promise<string>;
    sources?: SharedIpSource[];
  } = {},
): Promise<RefreshOutcome> {
  const now = opts.now ?? new Date();
  const sources = opts.sources ?? SHARED_IP_SOURCES;
  const fetchText = opts.fetchText ?? defaultFetchText;
  try {
    const { data, error } = await supabase
      .from('anti_cheat_shared_ip_sources')
      .select('source, refreshed_at');
    if (error) return { source: null, error: `read sources: ${error.message}` };
    const last = new Map<string, number>();
    for (const row of (data ?? []) as Array<{ source: string; refreshed_at: string }>) {
      last.set(row.source, Date.parse(row.refreshed_at));
    }
    const due = sources
      .map((s) => ({ s, at: last.get(s.source) ?? 0 }))
      .filter(({ at }) => now.getTime() - at >= REFRESH_EVERY_MS)
      .sort((a, b) => a.at - b.at);
    if (due.length === 0) return { source: null, skipped: 'all sources fresh' };

    const { s } = due[0];
    let cidrs: string[];
    try {
      cidrs = await s.load(fetchText);
    } catch (err) {
      return { source: s.source, error: `download: ${(err as Error).message}` };
    }
    if (cidrs.length < s.minRanges) {
      return {
        source: s.source,
        error: `only ${cidrs.length} ranges (expected at least ${s.minRanges}); previous list kept`,
      };
    }
    let total = 0;
    for (let i = 0; i < cidrs.length; i += CHUNK) {
      const { data: n, error: rpcErr } = await supabase.rpc('fn_anti_cheat_replace_shared_ip_ranges', {
        p_source: s.source,
        p_label: s.label,
        p_cidrs: cidrs.slice(i, i + CHUNK),
        p_first: i === 0,
      } as Record<string, unknown>);
      if (rpcErr) {
        // A list cut short must not count as fresh: mark it due again.
        if (i > 0) {
          await supabase
            .from('anti_cheat_shared_ip_sources')
            .update({ refreshed_at: new Date(0).toISOString() })
            .eq('source', s.source);
        }
        return { source: s.source, error: `store: ${rpcErr.message}` };
      }
      total = Number(n ?? 0);
    }
    return { source: s.source, ranges: total };
  } catch (err) {
    return { source: null, error: (err as Error).message };
  }
}
