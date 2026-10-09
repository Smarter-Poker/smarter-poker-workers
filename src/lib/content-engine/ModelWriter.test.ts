import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  create: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('../grok.js', () => ({
  getGrokClient: () => ({ chat: { completions: { create: mocks.create } } }),
}));

vi.mock('../supabase.js', () => ({
  getSupabase: () => {
    const query = {
      select: vi.fn(() => query),
      limit: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: mocks.config, error: null })),
    };
    return { from: vi.fn(() => query), rpc: mocks.rpc };
  },
}));

import type { PostBrief } from './PostBrief.js';
import { styleSheetFor } from './StyleSheet.js';
import {
  CAPTION_MODEL_MAX_BILLABLE_INPUT_TOKENS,
  CAPTION_MODEL_MAX_OUTPUT_TOKENS,
  CAPTION_MODEL_NAME,
  CAPTION_MODEL_PRICING_SOURCE,
  CAPTION_MODEL_TIMEOUT_MS,
  CAPTION_MODEL_WORST_CASE_MICROUSD,
  _resetModelWriterConfigCache,
  captionModelIdempotencyKey,
  takeModelWriterStats,
  writeModelCaption,
} from './ModelWriter.js';

const brief: PostBrief = {
  kind: 'video',
  domain: 'poker',
  title: 'Phil Ivey finds a river bluff at the final table',
  source: 'PokerGO',
  people: ['Phil Ivey'],
  teams: [],
  concepts: ['bluff', 'river', 'final_table'],
  amounts: [],
  topic: 'Phil Ivey river bluff',
  tone: 'analytical',
  isQuestion: false,
  confidence: 1,
  builtFrom: ['title'],
};
const style = styleSheetFor('horse-a');

function enabledConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    provider: 'xai',
    model: CAPTION_MODEL_NAME,
    daily_budget_microusd: 100_000,
    request_reservation_microusd: CAPTION_MODEL_WORST_CASE_MICROUSD,
    provider_qualified_at: new Date().toISOString(),
    provider_qualified_model: CAPTION_MODEL_NAME,
    provider_qualified_reservation_microusd: CAPTION_MODEL_WORST_CASE_MICROUSD,
    ...overrides,
  };
}

function reservation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision: 'reserved',
    reservation_id: 'reservation-a',
    provider: 'xai',
    model: CAPTION_MODEL_NAME,
    reserved_microusd: CAPTION_MODEL_WORST_CASE_MICROUSD,
    daily_budget_microusd: 100_000,
    committed_microusd: CAPTION_MODEL_WORST_CASE_MICROUSD,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  takeModelWriterStats();
  _resetModelWriterConfigCache();
  mocks.config = enabledConfig();
  mocks.rpc.mockImplementation(async (name: string) => name === 'reserve_caption_model_budget'
    ? { data: [reservation()], error: null }
    : { data: [{ settled: true, charged_microusd: 7, committed_microusd: 7 }], error: null });
  mocks.create.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({
      caption: 'Phil Ivey found the river bluff because the line held together.',
      core_meaning: 'Phil Ivey found the river bluff',
      grounding_fact: 'Phil Ivey',
    }) } }],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  });
});

describe('budgeted caption ModelWriter', () => {
  it('uses a stable bounded reservation key for long URLs and separates distinct assets', () => {
    const publicationKey = `fleet:${'horse-id-'.repeat(8)}:2026-10-09T05`;
    const longUrl = `https://news.example/story?${'tracking=value&'.repeat(80)}`;
    const key = captionModelIdempotencyKey(publicationKey, longUrl);
    expect(key).toHaveLength(75);
    expect(key).toBe(captionModelIdempotencyKey(publicationKey, longUrl));
    expect(key).not.toBe(captionModelIdempotencyKey(publicationKey, `${longUrl}different`));
  });

  it('pins the exact dated model price and refuses briefs without a source fact before spending', async () => {
    expect(CAPTION_MODEL_NAME).toBe('grok-4.20-0309-non-reasoning');
    expect(CAPTION_MODEL_PRICING_SOURCE).toBe('https://docs.x.ai/developers/models/grok-4.20-non-reasoning');
    expect(CAPTION_MODEL_WORST_CASE_MICROUSD).toBe(12_900);
    await expect(writeModelCaption({
      idempotencyKey: 'caption:slot:empty',
      brief: { ...brief, topic: 'poker', keyPhrase: 'bluff', people: [], teams: [], amounts: [] },
      style,
      deterministicDraft: 'reference',
    })).resolves.toEqual({ status: 'unavailable', reason: 'no_grounded_fact' });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('does not reserve or call a provider when the default-off setting is disabled', async () => {
    mocks.config = enabledConfig({ enabled: false });
    await expect(writeModelCaption({
      idempotencyKey: 'caption:slot:asset', brief, style, deterministicDraft: 'reference',
    })).resolves.toEqual({ status: 'unavailable', reason: 'disabled' });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('refuses unsupported, stale, or under-reserved config before budget or provider work', async () => {
    for (const config of [
      enabledConfig({ model: 'grok-latest' }),
      enabledConfig({ provider_qualified_at: '2026-01-01T00:00:00.000Z' }),
      enabledConfig({ request_reservation_microusd: CAPTION_MODEL_WORST_CASE_MICROUSD - 1 }),
      enabledConfig({ provider_qualified_reservation_microusd: CAPTION_MODEL_WORST_CASE_MICROUSD + 1 }),
    ]) {
      mocks.config = config;
      const result = await writeModelCaption({
        idempotencyKey: 'caption:slot:asset', brief, style, deterministicDraft: 'reference',
      });
      expect(result.status).toBe('unavailable');
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('reserves first, calls only the exact capped model, settles provider cost, and returns grounded output', async () => {
    await expect(writeModelCaption({
      idempotencyKey: 'caption:slot:asset', brief, style, deterministicDraft: 'reference',
    })).resolves.toMatchObject({
      status: 'accepted',
      semanticKey: 'meaning:phil ivey found the river bluff',
      grounding: ['model_fact:Phil Ivey'],
    });
    expect(mocks.rpc.mock.calls[0]).toEqual([
      'reserve_caption_model_budget', { p_idempotency_key: 'caption:slot:asset' },
    ]);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      model: CAPTION_MODEL_NAME,
      max_tokens: CAPTION_MODEL_MAX_OUTPUT_TOKENS,
      response_format: { type: 'json_object' },
    }), { timeout: CAPTION_MODEL_TIMEOUT_MS, maxRetries: 0 });
    expect(mocks.rpc.mock.calls[1]).toEqual(['settle_caption_model_budget', {
      p_reservation_id: 'reservation-a',
      p_idempotency_key: 'caption:slot:asset',
      p_charged_microusd: 7,
    }]);
    expect(takeModelWriterStats()).toMatchObject({
      caption_model_reserved_microusd: CAPTION_MODEL_WORST_CASE_MICROUSD,
      caption_model_settled_microusd: 7,
      caption_model_budget_remaining_snapshot_microusd: 100_000 - CAPTION_MODEL_WORST_CASE_MICROUSD,
    });
  });

  it('does not call the provider for duplicate or exhausted reservations', async () => {
    for (const decision of ['duplicate', 'budget_exhausted']) {
      mocks.rpc.mockResolvedValueOnce({ data: [reservation({ decision })], error: null });
      const result = await writeModelCaption({
        idempotencyKey: `caption:slot:${decision}`, brief, style, deterministicDraft: 'reference',
      });
      expect(result).toMatchObject({ status: 'unavailable', reason: decision });
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('retains an unknown provider reservation and never retries or settles it', async () => {
    mocks.create.mockRejectedValue(new Error('timeout'));
    await expect(writeModelCaption({
      idempotencyKey: 'caption:slot:asset', brief, style, deterministicDraft: 'reference',
    })).resolves.toEqual({ status: 'unavailable', reason: 'provider_unavailable' });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(takeModelWriterStats()).toMatchObject({
      caption_model_reserved_microusd: CAPTION_MODEL_WORST_CASE_MICROUSD,
      caption_model_retained_unknown_microusd: CAPTION_MODEL_WORST_CASE_MICROUSD,
    });
  });

  it('settles definitive provider usage but rejects generic or invented grounding', async () => {
    mocks.create.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        caption: 'Poker rewards patience.',
        core_meaning: 'Poker rewards patience',
        grounding_fact: 'Poker',
      }) } }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    });
    await expect(writeModelCaption({
      idempotencyKey: 'caption:slot:asset', brief, style, deterministicDraft: 'reference',
    })).resolves.toEqual({ status: 'unavailable', reason: 'invalid_output' });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it('rejects invented title-case names, quotations, numbers, and card notation after usage settles', async () => {
    const cases = [
      { candidateBrief: brief, caption: 'Phil Ivey finds a river bluff against Tom Dwan.' },
      { candidateBrief: brief, caption: 'Phil Ivey finds a river bluff and wins $50,000.' },
      { candidateBrief: brief, caption: 'Phil Ivey finds a river bluff. "Easy call."' },
      { candidateBrief: brief, caption: 'Phil Ivey finds a river bluff with As Kh.' },
      {
        candidateBrief: { ...brief, title: 'Phil Ivey finds a river bluff in a 10bb pot', amounts: ['10bb'] },
        caption: 'Phil Ivey finds a river bluff in a 1bb pot.',
      },
    ];
    for (const { candidateBrief, caption } of cases) {
      mocks.create.mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({
          caption,
          core_meaning: 'Phil Ivey finds a river bluff',
          grounding_fact: 'Phil Ivey',
        }) } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      });
      await expect(writeModelCaption({
        idempotencyKey: `caption:slot:${caption}`,
        brief: candidateBrief,
        style,
        deterministicDraft: 'reference',
      })).resolves.toEqual({ status: 'unavailable', reason: 'invalid_output' });
    }
    expect(mocks.create).toHaveBeenCalledTimes(cases.length);
    expect(mocks.rpc).toHaveBeenCalledTimes(cases.length * 2);
  });

  it('allows exact numeric and card facts already present in the source', async () => {
    const sourcedBrief = {
      ...brief,
      title: 'Phil Ivey finds a river bluff with As Kh in a 10bb pot',
      amounts: ['10bb'],
    };
    mocks.create.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        caption: 'Phil Ivey finds a river bluff with As Kh in a 10bb pot.',
        core_meaning: 'Phil Ivey finds a river bluff with As Kh in a 10bb pot',
        grounding_fact: 'Phil Ivey',
      }) } }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    });
    await expect(writeModelCaption({
      idempotencyKey: 'caption:slot:sourced-cards',
      brief: sourcedBrief,
      style,
      deterministicDraft: 'reference',
    })).resolves.toMatchObject({ status: 'accepted' });
  });

  it('rejects missing or above-reservation cost without pretending settlement succeeded', async () => {
    for (const usage of [
      {},
      { prompt_tokens: CAPTION_MODEL_MAX_BILLABLE_INPUT_TOKENS + 1, completion_tokens: CAPTION_MODEL_MAX_OUTPUT_TOKENS },
    ]) {
      mocks.create.mockResolvedValueOnce({ choices: [{ message: { content: '{}' } }], usage });
      const result = await writeModelCaption({
        idempotencyKey: `caption:slot:${JSON.stringify(usage)}`, brief, style, deterministicDraft: 'reference',
      });
      expect(result.status).toBe('unavailable');
    }
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });
});
