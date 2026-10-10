import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  phraseRecentlyUsed: vi.fn(),
  writeModelCaption: vi.fn(),
}));

vi.mock('./ModelWriter.js', () => ({
  writeModelCaption: mocks.writeModelCaption,
}));
vi.mock('./ContentLedger.js', () => ({
  groundedPhraseRecentlyUsed: vi.fn(async () => false),
  normalizePhrase: (value: string) => `norm:${value.toLowerCase()}`,
  phraseRecentlyUsed: mocks.phraseRecentlyUsed,
  phraseUsedOnPost: vi.fn(async () => false),
  recentFrameKeys: vi.fn(async () => new Set()),
}));

import { writeCaption } from './VoiceWriter.js';

const horse = { profile_id: 'horse-a', name: 'Alpha' };
const asset = {
  kind: 'video' as const,
  title: 'Phil Ivey finds a river bluff at the final table',
  source: 'PokerGO',
  domainHint: 'poker' as const,
};

const unsupportedNews = {
  kind: 'link' as const,
  title: 'Neighborhood cardroom announces autumn hours after renovation',
  source: 'PokerNews',
  domainHint: 'poker' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.phraseRecentlyUsed.mockResolvedValue(false);
  mocks.writeModelCaption.mockResolvedValue({
    status: 'accepted',
    text: 'Phil Ivey made the river bluff work because the line held together.',
    semanticKey: 'meaning:phil ivey river bluff line',
    grounding: ['model_fact:Phil Ivey'],
  });
});

describe('VoiceWriter model candidate gates', () => {
  it('puts accepted model text through the existing relevance and phrase gates', async () => {
    const written = await writeCaption(horse, asset, [], { modelIdempotencyKey: 'caption:slot:asset' });
    expect(written.text).toContain('Phil Ivey');
    expect(written.semanticKey).toBe('meaning:phil ivey river bluff line');
    expect(written.relevance).toBeGreaterThanOrEqual(0.3);
    expect(mocks.phraseRecentlyUsed).toHaveBeenCalledWith('meaning:phil ivey river bluff line', 'horse-a');
    expect(mocks.phraseRecentlyUsed).toHaveBeenCalledWith(
      'norm:phil ivey made the river bluff work because the line held together.',
      'horse-a',
    );
  });

  it('rejects reused model meaning and continues through deterministic fallback drafts', async () => {
    mocks.phraseRecentlyUsed.mockImplementation(async (key: string) => key === 'meaning:phil ivey river bluff line');
    const written = await writeCaption(horse, asset, [], { modelIdempotencyKey: 'caption:slot:asset' });
    expect(written.text).not.toContain('made the river bluff work because the line held together');
    expect(written.text).not.toBe('');
    expect(written.attempts).toBeGreaterThan(1);
  });

  it('never asks the model without a stable publication/asset idempotency key', async () => {
    mocks.writeModelCaption.mockResolvedValue({ status: 'unavailable', reason: 'not_requested' });
    await writeCaption(horse, asset);
    expect(mocks.writeModelCaption).not.toHaveBeenCalled();
  });

  it('bounds candidate and fallback retries to one request-local model attempt', async () => {
    const modelAttempt = {};
    await writeCaption(horse, asset, [], { modelIdempotencyKey: 'caption:first', modelAttempt });
    await writeCaption(horse, { ...asset, title: 'Phil Ivey folds the river' }, [], {
      modelIdempotencyKey: 'caption:fallback',
      modelAttempt,
    });
    expect(mocks.writeModelCaption).toHaveBeenCalledTimes(1);
    expect(modelAttempt).toEqual({ attempted: true });
  });

  it('uses a truthful source-attributed report for a fresh news title with no supported opinion', async () => {
    mocks.writeModelCaption.mockResolvedValue({ status: 'disabled', reason: 'disabled' });

    const written = await writeCaption(horse, unsupportedNews);

    expect(written.text).toContain('PokerNews');
    expect(written.text).toContain('Neighborhood cardroom announces autumn hours after renovation');
    expect(written.text).not.toMatch(/worth a look|stuck with me|I think|I believe/i);
    expect(written.semanticKey).toContain('source report pokernews neighborhood cardroom announces autumn hours after renovation');
    expect(written.relevance).toBeGreaterThanOrEqual(0.3);
  });

  it('preserves the complete source headline across horse style sheets', async () => {
    mocks.writeModelCaption.mockResolvedValue({ status: 'disabled', reason: 'disabled' });
    for (const profile_id of ['horse-a', '00000000-0000-4000-8000-000000000001', 'horse-z']) {
      const written = await writeCaption({ ...horse, profile_id }, unsupportedNews);
      expect(written.text).toContain(unsupportedNews.title);
      expect(written.text).not.toMatch(/\.\.\.|…/);
    }
  });

  it('keeps unsupported video titles silent and rejects clipped news headlines', async () => {
    mocks.writeModelCaption.mockResolvedValue({ status: 'disabled', reason: 'disabled' });
    expect((await writeCaption(horse, { ...unsupportedNews, kind: 'video' })).text).toBe('');
    expect((await writeCaption(horse, { ...unsupportedNews, title: 'Neighborhood cardroom announces autumn hours and the' })).text).toBe('');
  });

  it('keeps source-attributed news behind the same semantic freshness gate', async () => {
    mocks.writeModelCaption.mockResolvedValue({ status: 'disabled', reason: 'disabled' });
    mocks.phraseRecentlyUsed.mockImplementation(async (key: string) => key.startsWith('meaning:source report'));

    const written = await writeCaption(horse, unsupportedNews);

    expect(written.text).toBe('');
    expect(written.stale).toBe(true);
  });
});
