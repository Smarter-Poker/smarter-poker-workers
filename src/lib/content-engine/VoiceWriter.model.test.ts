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
});
