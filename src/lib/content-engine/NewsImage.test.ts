import { describe, expect, it } from 'vitest';
import { extractArticleImageUrl, safeArticleUrl } from './NewsImage.js';

describe('article image extraction', () => {
  it.each([
    [{ enclosure: { url: 'https://cdn.example/enclosure.webp' } }, 'https://cdn.example/enclosure.webp'],
    [{ 'media:content': { $: { url: 'https://cdn.example/media.jpg' } } }, 'https://cdn.example/media.jpg'],
    [{ 'media:thumbnail': { $: { url: 'https://cdn.example/thumb.png' } } }, 'https://cdn.example/thumb.png'],
    [{ 'content:encoded': '<p><img src="https://cdn.example/story.jpeg" alt="story"></p>' }, 'https://cdn.example/story.jpeg'],
    [{ description: "<img src='https://cdn.example/description.webp'>" }, 'https://cdn.example/description.webp'],
  ])('uses the maintained RSS image shapes', (item, expected) => {
    expect(extractArticleImageUrl(item)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)',
    'ftp://cdn.example/story.jpg',
    'https://cdn.example/favicon.ico',
    'https://cdn.example/publisher-logo.png',
    'https://cdn.example/placeholder.jpg',
  ])('rejects unsafe or generic artwork: %s', (url) => {
    expect(extractArticleImageUrl({ enclosure: { url } })).toBeNull();
  });
});

describe('article URL validation', () => {
  it('canonicalises ordinary web article URLs', () => {
    expect(safeArticleUrl(' https://news.example/story?q=1 ')).toBe('https://news.example/story?q=1');
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@news.example/story', 'not a url'])(
    'rejects an unsafe article URL: %s',
    (value) => expect(safeArticleUrl(value)).toBeNull(),
  );
});
