import { describe, expect, it } from 'vitest';
import { scrapePokerStarsBlog } from './news-scraper.js';

const source = {
  box: 7,
  name: 'PokerStars Blog',
  type: 'scrape' as const,
  url: 'https://www.pokerstarsblog.com/',
  baseUrl: 'https://www.pokerstarsblog.com',
  icon: '♠️',
  category: 'news',
};

describe('PokerStars Blog source', () => {
  it('extracts only real editorial cards and decodes titles', async () => {
    const html = `
      <a href="/poker/learn/news/ept-barcelona-final-table/">
        <img data-src="https://cdn.example/ept.webp" />
        <h3 class="h4">EPT Barcelona: Foxen &amp; Mateos reach the final table</h3>
      </a>
      <a href="/poker/deposit/"><h3 class="h4">Deposit now</h3></a>
    `;
    const rows = await scrapePokerStarsBlog(html, source);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      url: 'https://www.pokerstarsblog.com/poker/learn/news/ept-barcelona-final-table/',
      title: 'EPT Barcelona: Foxen & Mateos reach the final table',
      image: 'https://cdn.example/ept.webp',
    });
  });

  it('deduplicates repeated cards and rejects fragment/query variants', async () => {
    const card = `<a href="/poker/learn/news/one-story/"><h3>A sufficiently descriptive poker headline</h3></a>`;
    const html = card + card
      + `<a href="/poker/learn/news/ignored/?ref=home"><h3>Ignored query link headline</h3></a>`;
    const rows = await scrapePokerStarsBlog(html, source);
    expect(rows).toHaveLength(1);
  });
});
