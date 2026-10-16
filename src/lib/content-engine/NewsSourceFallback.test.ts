import { describe, expect, it } from 'vitest';
import { orderedNewsSources } from './NewsSourceFallback.js';

describe('bounded configured news failover', () => {
  const sources = [
    { name: 'A', rss: 'https://a.example/rss', fallback_urls: ['https://a.example/alternate', 'https://b.example/rss'] },
    { name: 'B', rss: 'https://b.example/rss' },
    { name: 'C', rss: 'https://c.example/rss' },
  ];
  it('retains the horse-selected feed, then peers, then distinct alternate endpoints', () => {
    expect(orderedNewsSources(sources, 1)).toEqual([
      { name: 'B', rss: 'https://b.example/rss' },
      { name: 'C', rss: 'https://c.example/rss' },
      { name: 'A', rss: 'https://a.example/rss' },
      { name: 'A', rss: 'https://a.example/alternate' },
    ]);
  });
  it('refuses unsafe URLs, deduplicates and bounds work even for a large registry', () => {
    expect(orderedNewsSources([{ name: 'bad', rss: 'file:///etc/passwd', fallback_urls: ['https://user:pass@news.example/rss'] }], 0)).toEqual([]);
    expect(orderedNewsSources(Array.from({ length: 100 }, (_, i) => ({ name: String(i), rss: `https://news.example/${i}` })), 0, 999)).toHaveLength(6);
    expect(orderedNewsSources(sources, 0, 2)).toHaveLength(2);
    expect(orderedNewsSources(Array.from({ length: 100 }, (_, i) => ({ name: String(i), rss: `https://news.example/${i}` })), 0, Number.NaN)).toHaveLength(6);
    expect(orderedNewsSources([], 0)).toEqual([]);
  });
});
