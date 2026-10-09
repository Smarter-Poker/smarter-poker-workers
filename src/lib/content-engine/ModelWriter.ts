/**
 * Optional Phase 2 caption model.
 *
 * The deterministic Composer remains the outage/budget fallback. This path
 * cannot call a provider until the database says the feature is enabled,
 * names an exact source-priced model, carries a recent entitlement proof and
 * atomically reserves a conservative worst-case request cost. Unknown calls
 * are never retried and their reservation remains charged against the day.
 */
import { getGrokClient } from '../grok.js';
import { getSupabase } from '../supabase.js';
import { createHash } from 'node:crypto';
import { meaningKey } from './Composer.js';
import { stripBannedGlyphs, type StyleSheet } from './StyleSheet.js';
import type { PostBrief } from './PostBrief.js';

export const CAPTION_MODEL_PROVIDER = 'xai';
export const CAPTION_MODEL_NAME = 'grok-4.20-0309-non-reasoning';
export const CAPTION_MODEL_PRICING_SOURCE = 'https://docs.x.ai/developers/models/grok-4.20-non-reasoning';
export const CAPTION_MODEL_PRICING_VERIFIED_AT = '2026-10-09';
export const CAPTION_MODEL_MAX_PROMPT_BYTES = 8_000;
export const CAPTION_MODEL_MAX_BILLABLE_INPUT_TOKENS = 10_000;
export const CAPTION_MODEL_MAX_OUTPUT_TOKENS = 160;
export const CAPTION_MODEL_TIMEOUT_MS = 12_000;
/**
 * Official global-endpoint price checked 2026-10-09: $1.25/M input and
 * $2.50/M output. Ten thousand billable input tokens covers the bounded
 * 8,000-byte prompt plus chat framing. No reasoning, tools, regional or
 * priority tier is requested. 10,000*1.25 + 160*2.50 = 12,900 micro-USD.
 */
function pricedMicrousd(tokens: number, quarterMicrousdPerToken: number): number {
  const scaled = tokens * quarterMicrousdPerToken;
  if (!Number.isSafeInteger(tokens) || tokens < 0 || !Number.isSafeInteger(scaled)) {
    throw new Error('caption model price calculation exceeds safe integer bounds');
  }
  return Math.ceil(scaled / 4);
}
export function captionModelWorstCaseMicrousd(): number {
  return pricedMicrousd(CAPTION_MODEL_MAX_BILLABLE_INPUT_TOKENS, 5)
    + pricedMicrousd(CAPTION_MODEL_MAX_OUTPUT_TOKENS, 10);
}
export const CAPTION_MODEL_WORST_CASE_MICROUSD = captionModelWorstCaseMicrousd();
const QUALIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const CONFIG_CACHE_MS = 30_000;

/** Stable, fixed-width key for the database's 200-character idempotency bound. */
export function captionModelIdempotencyKey(publicationKey: string, assetIdentity: string): string {
  const digest = createHash('sha256')
    .update(publicationKey)
    .update('\0')
    .update(assetIdentity)
    .digest('hex');
  return `caption:v1:${digest}`;
}

type ModelReason =
  | 'not_requested'
  | 'no_grounded_fact'
  | 'config_unavailable'
  | 'disabled'
  | 'unsupported_config'
  | 'qualification_stale'
  | 'reservation_too_small'
  | 'prompt_too_large'
  | 'budget_unavailable'
  | 'budget_exhausted'
  | 'duplicate'
  | 'provider_unavailable'
  | 'provider_cost_unknown'
  | 'provider_cost_exceeded_reservation'
  | 'invalid_output';

export type ModelCaptionResult =
  | { status: 'accepted'; text: string; semanticKey: string; grounding: string[] }
  | { status: 'unavailable'; reason: ModelReason };

interface BudgetConfig {
  enabled: boolean;
  provider: string | null;
  model: string | null;
  daily_budget_microusd: number;
  request_reservation_microusd: number;
  provider_qualified_at: string | null;
  provider_qualified_model: string | null;
  provider_qualified_reservation_microusd: number | null;
}

interface Reservation {
  decision: 'reserved' | 'duplicate' | 'disabled' | 'unconfigured' | 'budget_exhausted';
  reservation_id: string | null;
  provider: string | null;
  model: string | null;
  reserved_microusd: number;
  daily_budget_microusd: number;
  committed_microusd: number;
}

const stats: Record<string, number> = {};
let cachedConfig: { readAt: number; value: BudgetConfig | null } | null = null;
function note(key: string): void {
  stats[key] = (stats[key] ?? 0) + 1;
}
function addMoney(key: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return;
  stats[key] = (stats[key] ?? 0) + value;
}
function budgetSnapshot(reservation: Reservation): void {
  if (
    Number.isSafeInteger(reservation.daily_budget_microusd)
    && Number.isSafeInteger(reservation.committed_microusd)
    && reservation.daily_budget_microusd >= 0
    && reservation.committed_microusd >= 0
  ) {
    stats.caption_model_budget_remaining_snapshot_microusd = Math.max(
      0,
      reservation.daily_budget_microusd - reservation.committed_microusd,
    );
  }
}
export function takeModelWriterStats(): Record<string, number> {
  const out = { ...stats };
  for (const key of Object.keys(stats)) delete stats[key];
  return out;
}
export function _resetModelWriterConfigCache(): void {
  cachedConfig = null;
}

function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T | undefined) ?? null;
  return data && typeof data === 'object' ? data as T : null;
}

function clean(value: string | null | undefined, max: number): string | undefined {
  const text = stripBannedGlyphs(String(value ?? '')).replace(/[\r\t]+/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
}

function compactBrief(brief: PostBrief): Record<string, unknown> {
  return {
    kind: brief.kind,
    domain: brief.domain,
    sport: brief.sport,
    title: clean(brief.title, 240),
    source: clean(brief.source, 100),
    people: brief.people.slice(0, 4).map((v) => clean(v, 80)).filter(Boolean),
    teams: brief.teams.slice(0, 4).map((v) => clean(v, 80)).filter(Boolean),
    concepts: brief.concepts.slice(0, 6).map((v) => clean(v, 50)).filter(Boolean),
    amounts: brief.amounts.slice(0, 4).map((v) => clean(v, 40)).filter(Boolean),
    keyPhrase: clean(brief.keyPhrase, 120),
    topic: clean(brief.topic, 160),
    tone: brief.tone,
    confidence: brief.confidence,
  };
}

function compactStyle(style: StyleSheet): Record<string, unknown> {
  return {
    length: style.length,
    casing: style.casing,
    punctuation: style.punctuation,
    opener: style.opener,
    closer: style.closer,
    voice: style.voice,
    certainty: style.certainty,
    slang: style.slang,
    numerals: style.numerals,
    layout: style.layout,
    lexicon: {
      interjections: style.lexicon.interjections.slice(0, 3),
      markers: style.lexicon.markers.slice(0, 3),
      verdicts: style.lexicon.verdicts.slice(0, 3),
      intensifiers: style.lexicon.intensifiers.slice(0, 3),
      hedges: style.lexicon.hedges.slice(0, 3),
    },
  };
}

function sourceFacts(brief: PostBrief): string[] {
  const namedOrMeasured = [...brief.people, ...brief.teams, ...brief.amounts];
  const distinctivePhrases = [brief.topic, brief.keyPhrase].filter((value) => {
    const cleaned = clean(value, 180);
    return !!cleaned && (cleaned.split(/\s+/).length >= 2 || /\d/.test(cleaned));
  });
  return [...new Set([...distinctivePhrases, ...namedOrMeasured]
    .map((value) => clean(value, 180))
    .filter((value): value is string => !!value && value.length >= 3))];
}

function normalizedEvidence(brief: PostBrief): string {
  return [
    brief.title,
    brief.source,
    ...sourceFacts(brief),
    ...brief.concepts,
  ].join(' ').replace(/\s+/g, ' ');
}

function objectiveTokens(value: string): Set<string> {
  const numeric = value.match(/(?:[$\u00a3\u20ac])?\b\d[\d,.]*(?:%|[kKmM]|bb)?\b/g) ?? [];
  const compactCards = value.match(/\b(?:[2-9TJQKA][cdhs]|(?:AA|KK|QQ|JJ|TT|AK|AQ|AJ|AT|KQ|KJ|KT|QJ|QT|JT)[so]?)\b/g) ?? [];
  const suitedCards = value.match(/(?:[2-9TJQKA][\u2663\u2666\u2665\u2660])/g) ?? [];
  const spokenCards = value.match(/\b(?:ace|aces|king|kings|queen|queens|jack|jacks|ten|tens)(?:\s+of\s+(?:clubs|diamonds|hearts|spades))?\b/gi) ?? [];
  return new Set([...numeric, ...compactCards, ...suitedCards, ...spokenCards]
    .map((token) => token.toLocaleLowerCase()));
}

function hasUnsupportedClaims(text: string, core: string, brief: PostBrief): boolean {
  const evidence = normalizedEvidence(brief);
  const lowerEvidence = evidence.toLocaleLowerCase();
  if (/[\u201c\u201d"]/u.test(text) || /[\u201c\u201d"]/u.test(core)) return true;

  // Numbers, cards, money and percentages are objective claims. A model may
  // repeat them only when the supplied asset already contains that token.
  const evidenceTokens = objectiveTokens(evidence);
  const claimTokens = objectiveTokens(`${text} ${core}`);
  if ([...claimTokens].some((token) => !evidenceTokens.has(token))) return true;

  // Multi-word title-case names are objective claims too. This is a bounded
  // extra guard, not an exhaustive entity recogniser; output still remains
  // default-off pending disconnected human review of real provider samples.
  const namedClaims = `${text} ${core}`.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) ?? [];
  if (namedClaims.some((claim) => !lowerEvidence.includes(claim.toLocaleLowerCase()))) return true;
  return false;
}

function buildPrompt(brief: PostBrief, style: StyleSheet, deterministicDraft: string): string {
  return JSON.stringify({
    task: 'Write one short social caption in the supplied horse style about only the supplied asset.',
    rules: [
      'Return JSON only with caption, core_meaning, and grounding_fact string fields.',
      'grounding_fact must be copied exactly from topic, keyPhrase, people, teams, or amounts.',
      'caption and core_meaning must both contain grounding_fact exactly.',
      'Do not invent a person, event, result, quote, number, card, action, or claim.',
      'Do not use emoji, em dash, en dash, hashtags, handles, links, or calls to action.',
      'core_meaning is the source-specific opening claim, not a style prefix or generic poker reaction.',
    ],
    brief: compactBrief(brief),
    style: compactStyle(style),
    deterministic_reference: clean(deterministicDraft, 500),
  });
}

function validConfig(config: BudgetConfig): ModelReason | null {
  if (!config.enabled) return 'disabled';
  if (
    config.provider?.trim() !== CAPTION_MODEL_PROVIDER
    || config.model?.trim() !== CAPTION_MODEL_NAME
    || !Number.isSafeInteger(config.daily_budget_microusd)
    || config.daily_budget_microusd <= 0
  ) return 'unsupported_config';
  if (
    !Number.isSafeInteger(config.request_reservation_microusd)
    || config.request_reservation_microusd < CAPTION_MODEL_WORST_CASE_MICROUSD
  ) return 'reservation_too_small';
  const qualifiedAt = Date.parse(config.provider_qualified_at ?? '');
  if (
    config.provider_qualified_model?.trim() !== CAPTION_MODEL_NAME
    || config.provider_qualified_reservation_microusd !== config.request_reservation_microusd
    || !Number.isFinite(qualifiedAt)
    || Date.now() - qualifiedAt < 0
    || Date.now() - qualifiedAt > QUALIFICATION_MAX_AGE_MS
  ) return 'qualification_stale';
  return null;
}

function validateOutput(raw: string, brief: PostBrief): { text: string; semanticKey: string; grounding: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;
  if (typeof value.caption !== 'string' || typeof value.core_meaning !== 'string' || typeof value.grounding_fact !== 'string') return null;
  const text = stripBannedGlyphs(value.caption).trim();
  const core = stripBannedGlyphs(value.core_meaning).trim();
  const fact = value.grounding_fact.trim();
  if (!text || !core || text.length > 600 || core.length > 240) return null;
  if (/[@#]|https?:\/\//i.test(text) || /[—–]/.test(value.caption)) return null;
  const allowed = sourceFacts(brief);
  const exact = allowed.find((candidate) => candidate.toLocaleLowerCase() === fact.toLocaleLowerCase());
  if (!exact) return null;
  const lowerText = text.toLocaleLowerCase();
  const lowerCore = core.toLocaleLowerCase();
  const lowerFact = exact.toLocaleLowerCase();
  if (!lowerText.includes(lowerFact) || !lowerCore.includes(lowerFact) || !lowerText.includes(lowerCore)) return null;
  if (hasUnsupportedClaims(text, core, brief)) return null;
  return { text, semanticKey: meaningKey(core), grounding: [`model_fact:${exact}`] };
}

async function readConfig(): Promise<BudgetConfig | null> {
  if (cachedConfig && Date.now() - cachedConfig.readAt < CONFIG_CACHE_MS) return cachedConfig.value;
  try {
    const response = await getSupabase()
      .from('caption_model_budget_settings')
      .select('enabled,provider,model,daily_budget_microusd,request_reservation_microusd,provider_qualified_at,provider_qualified_model,provider_qualified_reservation_microusd')
      .limit(1)
      .maybeSingle();
    const value = response.error || !response.data ? null : response.data as BudgetConfig;
    cachedConfig = { readAt: Date.now(), value };
    return value;
  } catch {
    cachedConfig = { readAt: Date.now(), value: null };
    return null;
  }
}

/** One bounded provider attempt. Every non-accepted result uses Composer. */
export async function writeModelCaption(input: {
  idempotencyKey?: string;
  brief: PostBrief;
  style: StyleSheet;
  deterministicDraft: string;
}): Promise<ModelCaptionResult> {
  if (!input.idempotencyKey) return { status: 'unavailable', reason: 'not_requested' };

  if (sourceFacts(input.brief).length === 0) {
    note('caption_model_no_grounded_fact');
    return { status: 'unavailable', reason: 'no_grounded_fact' };
  }

  const prompt = buildPrompt(input.brief, input.style, input.deterministicDraft);
  if (Buffer.byteLength(prompt, 'utf8') > CAPTION_MODEL_MAX_PROMPT_BYTES) {
    note('caption_model_prompt_too_large');
    return { status: 'unavailable', reason: 'prompt_too_large' };
  }

  const config = await readConfig();
  if (!config) {
    note('caption_model_config_unavailable');
    return { status: 'unavailable', reason: 'config_unavailable' };
  }
  const configReason = validConfig(config);
  if (configReason) {
    note(`caption_model_${configReason}`);
    return { status: 'unavailable', reason: configReason };
  }

  let reservation: Reservation | null = null;
  try {
    const response = await getSupabase().rpc('reserve_caption_model_budget', {
      p_idempotency_key: input.idempotencyKey,
    });
    if (response.error) throw new Error(response.error.message);
    reservation = firstRow<Reservation>(response.data);
  } catch {
    note('caption_model_budget_unavailable');
    return { status: 'unavailable', reason: 'budget_unavailable' };
  }
  if (!reservation) return { status: 'unavailable', reason: 'budget_unavailable' };
  budgetSnapshot(reservation);
  if (reservation.decision !== 'reserved') {
    const reason: ModelReason = reservation.decision === 'budget_exhausted'
      ? 'budget_exhausted'
      : reservation.decision === 'duplicate'
        ? 'duplicate'
        : 'budget_unavailable';
    note(`caption_model_${reason}`);
    return { status: 'unavailable', reason };
  }
  if (
    !reservation.reservation_id
    || reservation.provider?.trim() !== CAPTION_MODEL_PROVIDER
    || reservation.model?.trim() !== CAPTION_MODEL_NAME
    || reservation.reserved_microusd !== config.request_reservation_microusd
    || reservation.reserved_microusd < CAPTION_MODEL_WORST_CASE_MICROUSD
  ) {
    note('caption_model_reservation_mismatch');
    return { status: 'unavailable', reason: 'budget_unavailable' };
  }
  addMoney('caption_model_reserved_microusd', reservation.reserved_microusd);

  let completion: Awaited<ReturnType<ReturnType<typeof getGrokClient>['chat']['completions']['create']>>;
  try {
    completion = await getGrokClient().chat.completions.create({
      model: CAPTION_MODEL_NAME,
      messages: [
        { role: 'system', content: 'You write grounded Smarter Poker horse captions. Follow the JSON contract exactly.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      max_tokens: CAPTION_MODEL_MAX_OUTPUT_TOKENS,
      temperature: 0.8,
    }, { timeout: CAPTION_MODEL_TIMEOUT_MS, maxRetries: 0 });
  } catch {
    // Provider acknowledgement/cost is unknown. Retain the full reservation
    // and never retry this idempotency key.
    note('caption_model_provider_unavailable');
    addMoney('caption_model_retained_unknown_microusd', reservation.reserved_microusd);
    return { status: 'unavailable', reason: 'provider_unavailable' };
  }

  const usage = completion.usage;
  const inputTokens = usage?.prompt_tokens;
  const outputTokens = usage?.completion_tokens;
  if (
    !Number.isSafeInteger(inputTokens)
    || !Number.isSafeInteger(outputTokens)
    || (inputTokens ?? -1) < 0
    || (outputTokens ?? -1) < 0
  ) {
    note('caption_model_provider_cost_unknown');
    addMoney('caption_model_retained_unknown_microusd', reservation.reserved_microusd);
    return { status: 'unavailable', reason: 'provider_cost_unknown' };
  }
  const chargedMicrousd = pricedMicrousd(inputTokens as number, 5)
    + pricedMicrousd(outputTokens as number, 10);
  if (chargedMicrousd > reservation.reserved_microusd) {
    note('caption_model_provider_cost_exceeded_reservation');
    return { status: 'unavailable', reason: 'provider_cost_exceeded_reservation' };
  }

  try {
    const settled = await getSupabase().rpc('settle_caption_model_budget', {
      p_reservation_id: reservation.reservation_id,
      p_idempotency_key: input.idempotencyKey,
      p_charged_microusd: chargedMicrousd,
    });
    const settlement = firstRow<{ settled: boolean; charged_microusd: number }>(settled.data);
    if (settled.error || settlement?.settled !== true) {
      note('caption_model_settlement_unknown');
      addMoney('caption_model_retained_unknown_microusd', reservation.reserved_microusd);
    } else {
      addMoney('caption_model_settled_microusd', settlement.charged_microusd);
    }
  } catch {
    // The original full reservation remains committed, so the hard cap is
    // still safe even when settlement acknowledgement is unknown.
    note('caption_model_settlement_unknown');
    addMoney('caption_model_retained_unknown_microusd', reservation.reserved_microusd);
  }

  const content = completion.choices[0]?.message?.content;
  const validated = typeof content === 'string' ? validateOutput(content, input.brief) : null;
  if (!validated) {
    note('caption_model_invalid_output');
    return { status: 'unavailable', reason: 'invalid_output' };
  }
  note('caption_model_accepted');
  return { status: 'accepted', ...validated };
}
