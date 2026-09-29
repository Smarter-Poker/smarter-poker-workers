/**
 * GET/POST /cron/phase6-content
 *
 * Builds Phase 6 data-native drafts from live club aggregates and the unified
 * local-event calendar. New publishing modes start disabled in
 * horse_post_modes. `?preview=1` is the only path that composes while a mode
 * is disabled, and it makes no content writes. A scheduled call also obeys the
 * fleet master switch before reading a mode or producing copy.
 *
 * Laws this route keeps (2026-09-21 recertification):
 * - Durable idempotency lives in the database. Every Phase 6 row carries its
 *   namespaced key in metadata.publication_key; unique expression indexes on
 *   social_posts and social_page_posts make a repeat insert fail with 23505,
 *   which counts as a duplicate. The social_posts.publication_key COLUMN is
 *   reserved for the video library (CHECK social_posts_managed_library_
 *   integrity_check) and is never written here.
 * - Reads that decide what is true are complete: paged past PostgREST's
 *   1,000-row cap, with a stable order, failing closed when incomplete.
 * - Only verified roster horses author feed posts or get named. A club digest
 *   is a page post, which the World Hub renders under the page's own identity,
 *   so it is written whoever owns the page. The feed mirror under the owner's
 *   personal profile is written only when the owner is a roster horse; for any
 *   other owner it is skipped and counted (mirror_skipped_author_not_horse).
 * - Every run reports how many drafts it skipped and why.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { pagedSelect, type PagedResult } from '../lib/pagedSelect.js';
import { engineEnabled, loadFleet, postModeEnabled } from '../lib/content-engine/Fleet.js';
import { postedRecently } from '../lib/content-engine/HorsePublisher.js';
import { normalizePhrase, recordPhrase } from '../lib/content-engine/ContentLedger.js';
import { fleetHash } from '../lib/content-engine/FleetScheduler.js';
import {
  buildClubDigestDraft,
  buildLocalEventDraft,
  buildSeasonalDraft,
  isJunkSourceText,
  placeKey,
  spreadLocalDrafts,
  type ClubPageRow,
  type ClubPeriodFacts,
  type ClubStatRow,
  type LocalEventFacts,
  type LocalEventRow,
  type LocalHorse,
  type MemberStatRow,
  type Phase6Draft,
  type Phase6Mode,
} from '../lib/content-engine/Phase6Content.js';

const PREVIEW_LIMIT = 24;
const PUBLISH_LIMIT_PER_MODE = 20;
/** Ceilings for complete reads. Reaching one is a failure, never a truncation. */
const CLUB_PAGES_MAX_ROWS = 5_000;
const CLUB_STATS_MAX_ROWS = 50_000;
const MEMBER_STATS_MAX_ROWS = 400_000;
const EVENT_WINDOW_MAX_ROWS = 50_000;
const PROFILE_CHUNK = 200;
const UNIQUE_VIOLATION = '23505';

export const PREVIEW_WRITES_NOTE =
  'Preview makes no content writes: no posts, page posts or phrase-ledger rows. '
  + 'The only write is the cron middleware logging this request in cron_execution_log.';

export type SkipReason =
  | 'duplicate'
  | 'recent'
  | 'junk'
  | 'author_not_horse'
  | 'mirror_skipped_author_not_horse'
  | 'stale_day'
  | 'failed'
  | 'rollback_failed';

export type SkipCounts = Record<SkipReason, number>;

export function emptySkips(): SkipCounts {
  return {
    duplicate: 0,
    recent: 0,
    junk: 0,
    author_not_horse: 0,
    mirror_skipped_author_not_horse: 0,
    stale_day: 0,
    failed: 0,
    rollback_failed: 0,
  };
}

export interface HeldDraft {
  reason: SkipReason;
  pageId?: string;
  detail?: string;
  draft: Phase6Draft | null;
}

export interface ModeComposition {
  drafts: Phase6Draft[];
  held: HeldDraft[];
  skipped: SkipCounts;
  notes: string[];
  error?: string;
}

export interface RosterHorse extends LocalHorse {
  displayName: string | null;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
}

function emptyComposition(): ModeComposition {
  return { drafts: [], held: [], skipped: emptySkips(), notes: [] };
}

/**
 * A complete read or an error. `build` must return a fresh, totally ordered
 * query for each page (see pagedSelect). Reaching `max` is treated as
 * incomplete even when the probe says otherwise, so a capped read can never
 * pass for a whole one.
 */
async function readAll<T>(label: string, build: Parameters<typeof pagedSelect>[0], max: number): Promise<T[]> {
  let result: PagedResult<T>;
  try {
    result = await pagedSelect<T>(build, max);
  } catch (error) {
    throw new Error(`${label} read failed: ${message(error)}`);
  }
  if (result.truncated || result.rows.length >= max) {
    throw new Error(`${label} read incomplete: reached the ${max}-row ceiling`);
  }
  return result.rows;
}

/**
 * Active content_authors joined to profiles.is_horse. Only a profile that is
 * both an active roster author and marked is_horse may author or be named.
 */
async function readRoster(): Promise<{ horses: Map<string, RosterHorse>; notHorse: number }> {
  const supa = getSupabase();
  const fleet = await loadFleet();
  const ids = [...new Set(fleet.map((horse) => horse.profile_id).filter((id): id is string => Boolean(id)))];
  const profiles = new Map<string, { id: string; city: string | null; state: string | null; is_horse: boolean | null; display_name: string | null; username: string | null }>();
  for (let i = 0; i < ids.length; i += PROFILE_CHUNK) {
    const { data, error } = await supa
      .from('profiles')
      .select('id, city, state, is_horse, display_name, username')
      .in('id', ids.slice(i, i + PROFILE_CHUNK));
    if (error) throw new Error(`horse profiles read failed: ${error.message}`);
    for (const row of (data ?? []) as Array<{ id: string; city: string | null; state: string | null; is_horse: boolean | null; display_name: string | null; username: string | null }>) {
      profiles.set(row.id, row);
    }
  }
  const horses = new Map<string, RosterHorse>();
  let notHorse = 0;
  for (const horse of fleet) {
    const profile = profiles.get(horse.profile_id);
    if (!profile || profile.is_horse !== true) {
      notHorse += 1;
      continue;
    }
    horses.set(horse.profile_id, {
      profile_id: horse.profile_id,
      name: horse.name,
      city: profile.city,
      state: profile.state,
      displayName: String(profile.display_name ?? profile.username ?? '').trim() || null,
    });
  }
  return { horses, notHorse };
}

/**
 * Exact per-period facts for one club: every member row of the period read
 * completely, cross-checked against an exact count. The leader is the single
 * top net earner (all rows, wins and losses) and is named only when that
 * member is a roster horse. Anything inexact is dropped, never estimated.
 */
async function readClubPeriodFacts(
  clubId: string,
  start: string,
  end: string,
  roster: Map<string, RosterHorse>,
  notes: string[],
): Promise<ClubPeriodFacts> {
  const supa = getSupabase();
  const facts: ClubPeriodFacts = { biggestPot: null, leader: null, jackpot: null, memberRows: null };
  const { data: jackpot, error: jackpotError } = await supa
    .from('bad_beat_jackpots')
    .select('id, current_amount')
    .eq('club_id', clubId)
    .eq('is_active', true)
    .order('current_amount', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (jackpotError) notes.push(`${clubId}: jackpot dropped (${jackpotError.message})`);
  else facts.jackpot = (jackpot as ClubPeriodFacts['jackpot']) ?? null;

  const { count, error: countError } = await supa
    .from('club_member_daily_stats')
    .select('user_id', { count: 'exact', head: true })
    .eq('club_id', clubId)
    .gte('stat_date', start)
    .lte('stat_date', end);
  let rows: MemberStatRow[];
  try {
    rows = await readAll<MemberStatRow>(
      'club member stats',
      () => supa
        .from('club_member_daily_stats')
        .select('stat_date, table_id, user_id, profit, biggest_pot_won')
        .eq('club_id', clubId)
        .gte('stat_date', start)
        .lte('stat_date', end)
        .order('stat_date', { ascending: true })
        .order('table_id', { ascending: true })
        .order('user_id', { ascending: true }),
      MEMBER_STATS_MAX_ROWS,
    );
  } catch (error) {
    notes.push(`${clubId}: biggest pot and leader dropped (${message(error)})`);
    return facts;
  }
  const unique = new Map<string, MemberStatRow>();
  for (const row of rows) unique.set(`${row.stat_date}|${row.table_id}|${row.user_id}`, row);
  if (countError || count === null || count === undefined || unique.size !== count || rows.length !== count) {
    notes.push(`${clubId}: biggest pot and leader dropped (member rows read ${rows.length}, distinct ${unique.size}, exact count ${countError ? `error ${countError.message}` : String(count)})`);
    return facts;
  }
  facts.memberRows = unique.size;
  const net = new Map<string, number>();
  let biggestPot = 0;
  for (const row of unique.values()) {
    biggestPot = Math.max(biggestPot, Number(row.biggest_pot_won ?? 0) || 0);
    if (row.user_id) net.set(row.user_id, (net.get(row.user_id) ?? 0) + (Number(row.profit ?? 0) || 0));
  }
  facts.biggestPot = biggestPot > 0 ? biggestPot : null;
  const ranked = [...net.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (!top || top[1] <= 0) return facts;
  if (ranked[1] && ranked[1][1] === top[1]) {
    notes.push(`${clubId}: leader dropped (tie for first)`);
    return facts;
  }
  const horse = roster.get(top[0]);
  if (!horse || !horse.displayName) {
    notes.push(`${clubId}: leader dropped (top earner is not a roster horse)`);
    return facts;
  }
  facts.leader = { user_id: top[0], display_name: horse.displayName, profit: Math.round(top[1] * 100) / 100 };
  return facts;
}

export interface ClubReadOptions {
  /** Real-clock yesterday; a live run reports only on it. Null in preview. */
  requiredDay: string | null;
}

export async function readClubComposition(
  now: Date,
  roster: Map<string, RosterHorse>,
  options: ClubReadOptions,
): Promise<ModeComposition> {
  const supa = getSupabase();
  const out = emptyComposition();
  const through = isoDay(addDays(now, -1));
  const weekly = now.getUTCDay() === 1;
  const start = weekly ? isoDay(addDays(now, -7)) : through;
  // Read a lookback window, not just the period, so a club whose latest day
  // is not yesterday is seen and skipped as stale rather than silently dropped.
  const since = isoDay(addDays(now, -14));
  const pages = await readAll<ClubPageRow>(
    'club pages',
    () => supa
      .from('social_pages')
      .select('id, owner_id, name, linked_entity_id, is_public')
      .eq('linked_entity_type', 'club')
      .eq('is_public', true)
      .not('linked_entity_id', 'is', null)
      .order('id', { ascending: true }),
    CLUB_PAGES_MAX_ROWS,
  );
  if (pages.length === 0) return out;
  const clubIds = [...new Set(pages.map((page) => page.linked_entity_id))];
  const stats = await readAll<ClubStatRow>(
    'club stats',
    () => supa
      .from('club_hand_daily')
      .select('club_id, stat_date, hands, pot_total')
      .in('club_id', clubIds)
      .gte('stat_date', since)
      .lte('stat_date', through)
      .order('club_id', { ascending: true })
      .order('stat_date', { ascending: true }),
    CLUB_STATS_MAX_ROWS,
  );
  for (const page of pages) {
    const recent = stats.filter((row) => row.club_id === page.linked_entity_id);
    if (recent.length === 0) {
      out.notes.push(`${page.id}: no club stats since ${since}`);
      continue;
    }
    const latest = recent.reduce((max, row) => (row.stat_date > max ? row.stat_date : max), '');
    if (latest !== through || (options.requiredDay !== null && through !== options.requiredDay)) {
      out.skipped.stale_day += 1;
      out.held.push({ reason: 'stale_day', pageId: page.id, detail: `latest stat ${latest}, report day ${through}`, draft: null });
      continue;
    }
    const own = recent.filter((row) => row.stat_date >= start);
    const facts = await readClubPeriodFacts(page.linked_entity_id, start, through, roster, out.notes);
    const draft = buildClubDigestDraft(page, own, { start, end: through, weekly }, facts);
    if (!draft) {
      out.notes.push(`${page.id}: nothing to report for ${start}..${through}`);
      continue;
    }
    // The page post renders under the page's identity whoever owns the page.
    // Only a verified roster horse also gets the digest mirrored to its feed.
    out.drafts.push({ ...draft, publish: roster.has(page.owner_id) ? 'page_and_feed' : 'page_only' });
  }
  return out;
}

export async function readLocalComposition(now: Date, horses: RosterHorse[]): Promise<ModeComposition> {
  const out = emptyComposition();
  const today = isoDay(now);
  const horizon = isoDay(addDays(now, 14));
  const supa = getSupabase();
  const events = await readAll<LocalEventRow>(
    'local events',
    () => supa
      .from('unified_events_calendar')
      .select('source, native_id, venue_name, event_name, specific_date, start_time, city, state, is_active, is_suppressed')
      .eq('is_active', true)
      .eq('is_suppressed', false)
      .gte('specific_date', today)
      .lte('specific_date', horizon)
      .order('specific_date', { ascending: true })
      .order('source', { ascending: true })
      .order('native_id', { ascending: true }),
    EVENT_WINDOW_MAX_ROWS,
  );
  const homes = new Set(horses.map((horse) => placeKey(horse.city, horse.state)).filter(Boolean));
  out.skipped.junk = events.filter((event) => homes.has(placeKey(event.city, event.state))
    && (isJunkSourceText(event.event_name) || isJunkSourceText(event.venue_name))).length;
  out.notes.push(`window ${today}..${horizon}: ${events.length} listings read completely`);
  const factsCache = new Map<LocalEventRow, LocalEventFacts | null>();
  const candidates = horses
    .map((horse) => buildLocalEventDraft(horse, events, today, horizon, now, factsCache))
    .filter((draft): draft is Phase6Draft => Boolean(draft));
  const firstByKey = new Map<string, Phase6Draft>();
  for (const draft of candidates) if (!firstByKey.has(draft.publicationKey)) firstByKey.set(draft.publicationKey, draft);
  out.drafts = spreadLocalDrafts([...firstByKey.values()]);
  return out;
}

export function readSeasonalComposition(now: Date, horses: RosterHorse[]): ModeComposition {
  const out = emptyComposition();
  const byKey = new Map<string, Phase6Draft[]>();
  for (const horse of horses) {
    const draft = buildSeasonalDraft(horse, now);
    if (!draft) continue;
    if (!byKey.has(draft.publicationKey)) byKey.set(draft.publicationKey, []);
    byKey.get(draft.publicationKey)!.push(draft);
  }
  // One post per city and month; the author rotates among that city's horses.
  for (const [key, group] of byKey) out.drafts.push(group[fleetHash(key, 'phase6-season-author') % group.length]!);
  return out;
}

/** Has this key been published as a feed post or a page post? */
async function alreadyPublished(publicationKey: string): Promise<boolean> {
  const supa = getSupabase();
  for (const table of ['social_posts', 'social_page_posts'] as const) {
    const { data, error } = await supa
      .from(table)
      .select('id')
      .eq('metadata->>publication_key', publicationKey)
      .limit(1);
    if (error) throw new Error(`publication ledger read failed (${table}): ${error.message}`);
    if ((data ?? []).length > 0) return true;
  }
  return false;
}

type PublishOutcome =
  | { status: 'posted'; id: string; mirror?: 'skipped_author_not_horse' }
  | { status: 'duplicate' }
  | { status: 'failed'; error: string }
  | { status: 'rollback_failed'; pagePostId: string; error: string };

function metadataFor(draft: Phase6Draft): Record<string, unknown> {
  return {
    scheduler: 'phase6',
    phase6_mode: draft.mode,
    publication_key: draft.publicationKey,
    source_id: draft.sourceId,
    grounding: draft.grounding,
  };
}

async function publishClubDraft(draft: Phase6Draft): Promise<PublishOutcome> {
  if (draft.publish !== 'page_and_feed' && draft.publish !== 'page_only') {
    return { status: 'failed', error: `club digest ${draft.publicationKey} carries no publish decision` };
  }
  const supa = getSupabase();
  const metadata = metadataFor(draft);
  const { data: pagePost, error: pageError } = await supa
    .from('social_page_posts')
    .insert({
      page_id: draft.pageId,
      author_id: draft.authorId,
      content: draft.content,
      content_type: 'text',
      media_urls: [],
      visibility: 'public',
      is_approved: true,
      post_type: 'regular',
      metadata,
    })
    .select('id')
    .maybeSingle();
  if (pageError?.code === UNIQUE_VIOLATION) return { status: 'duplicate' };
  if (pageError || !pagePost?.id) return { status: 'failed', error: `club page post failed: ${pageError?.message ?? 'missing id'}` };
  if (draft.publish === 'page_only') {
    // The owner is not a roster horse: the page post stands on its own under
    // the page's identity and nothing is written under the owner's feed.
    return { status: 'posted', id: pagePost.id, mirror: 'skipped_author_not_horse' };
  }
  const { data: feedPost, error: feedError } = await supa
    .from('social_posts')
    .insert({
      author_id: draft.authorId,
      content: draft.content,
      content_type: 'text',
      media_urls: [],
      visibility: 'public',
      metadata: { ...metadata, source: 'social_page_post', source_page_id: draft.pageId, source_post_id: pagePost.id },
    })
    .select('id')
    .maybeSingle();
  if (!feedError && feedPost?.id) return { status: 'posted', id: feedPost.id };
  const feedMessage = feedError?.message ?? 'missing id';
  const { data: removed, error: rollbackError } = await supa
    .from('social_page_posts')
    .delete()
    .eq('id', pagePost.id)
    .select('id');
  if (rollbackError || (removed ?? []).length !== 1) {
    // The page post stays behind. Its metadata.publication_key makes the next
    // run's duplicate check see it, so it is never posted twice.
    return {
      status: 'rollback_failed',
      pagePostId: pagePost.id,
      error: `club feed mirror failed (${feedMessage}); rollback of page post ${pagePost.id} failed: ${rollbackError?.message ?? `deleted ${(removed ?? []).length} rows`}`,
    };
  }
  if (feedError?.code === UNIQUE_VIOLATION) return { status: 'duplicate' };
  return { status: 'failed', error: `club feed mirror failed; page post ${pagePost.id} rolled back: ${feedMessage}` };
}

async function publishHorseDraft(draft: Phase6Draft): Promise<PublishOutcome> {
  const { data, error } = await getSupabase()
    .from('social_posts')
    .insert({
      author_id: draft.authorId,
      content: draft.content,
      content_type: 'text',
      media_urls: [],
      visibility: 'public',
      link_url: draft.linkUrl ?? null,
      metadata: metadataFor(draft),
    })
    .select('id')
    .maybeSingle();
  if (error?.code === UNIQUE_VIOLATION) return { status: 'duplicate' };
  if (error || !data?.id) return { status: 'failed', error: `horse Phase 6 post failed: ${error?.message ?? 'missing id'}` };
  await recordPhrase(normalizePhrase(draft.content), draft.authorId, data.id);
  return { status: 'posted', id: data.id };
}

export interface ModeResult {
  posted: number;
  candidates: number;
  attempted: number;
  skipped: SkipCounts;
  errors: string[];
  rollback_failed_page_posts: string[];
  held: Array<{ reason: SkipReason; page_id?: string; detail?: string }>;
  notes: string[];
}

async function publishMode(mode: Phase6Mode, composition: ModeComposition): Promise<ModeResult> {
  const result: ModeResult = {
    posted: 0,
    candidates: composition.drafts.length,
    attempted: 0,
    skipped: { ...composition.skipped },
    errors: composition.error ? [composition.error] : [],
    rollback_failed_page_posts: [],
    held: composition.held.map((item) => ({ reason: item.reason, page_id: item.pageId, detail: item.detail })),
    notes: composition.notes,
  };
  for (const draft of composition.drafts.slice(0, PUBLISH_LIMIT_PER_MODE)) {
    result.attempted += 1;
    try {
      if (await alreadyPublished(draft.publicationKey)) {
        result.skipped.duplicate += 1;
        continue;
      }
    } catch (error) {
      result.skipped.failed += 1;
      result.errors.push(message(error));
      continue;
    }
    // The 20-hour guard paces a horse's own feed and fails closed: an
    // unreadable guard counts as recent. A page-only club digest writes no
    // feed row under anyone, so the guard does not apply to it.
    if (draft.publish !== 'page_only') {
      let recent = true;
      try {
        recent = await postedRecently(draft.authorId);
      } catch (error) {
        result.notes.push(`recent-post guard unavailable for ${draft.authorId}: ${message(error)}`);
      }
      if (recent) {
        result.skipped.recent += 1;
        continue;
      }
    }
    let outcome: PublishOutcome;
    try {
      outcome = mode === 'club_data_digest' ? await publishClubDraft(draft) : await publishHorseDraft(draft);
    } catch (error) {
      outcome = { status: 'failed', error: message(error) };
    }
    if (outcome.status === 'posted') {
      result.posted += 1;
      if (outcome.mirror === 'skipped_author_not_horse') result.skipped.mirror_skipped_author_not_horse += 1;
    } else if (outcome.status === 'duplicate') result.skipped.duplicate += 1;
    else if (outcome.status === 'rollback_failed') {
      result.skipped.rollback_failed += 1;
      result.rollback_failed_page_posts.push(outcome.pagePostId);
      result.errors.push(outcome.error);
    } else {
      result.skipped.failed += 1;
      result.errors.push(outcome.error);
    }
  }
  return result;
}

export interface Phase6Composition {
  compositions: Map<Phase6Mode, ModeComposition>;
  rosterNotHorse: number;
}

/**
 * Compose every enabled mode. Each mode fails on its own: a read error in one
 * mode is reported for that mode and never publishes on a partial read.
 */
export async function composePhase6(
  now: Date,
  enabled: Map<Phase6Mode, boolean>,
  options: { preview: boolean; clock?: () => Date },
): Promise<Phase6Composition> {
  const compositions = new Map<Phase6Mode, ModeComposition>();
  const modes: Phase6Mode[] = ['club_data_digest', 'local_event', 'seasonal_local'];
  for (const mode of modes) compositions.set(mode, emptyComposition());
  if (!modes.some((mode) => enabled.get(mode))) return { compositions, rosterNotHorse: 0 };

  let roster: Map<string, RosterHorse>;
  let rosterNotHorse = 0;
  try {
    const read = await readRoster();
    roster = read.horses;
    rosterNotHorse = read.notHorse;
  } catch (error) {
    for (const mode of modes) {
      if (!enabled.get(mode)) continue;
      const failed = emptyComposition();
      failed.skipped.failed = 1;
      failed.error = message(error);
      compositions.set(mode, failed);
    }
    return { compositions, rosterNotHorse: 0 };
  }
  const horses = [...roster.values()];
  const clock = options.clock ?? (() => new Date());
  const readers: Record<Phase6Mode, () => Promise<ModeComposition>> = {
    club_data_digest: () => readClubComposition(now, roster, {
      requiredDay: options.preview ? null : isoDay(addDays(clock(), -1)),
    }),
    local_event: () => readLocalComposition(now, horses),
    seasonal_local: async () => readSeasonalComposition(now, horses),
  };
  for (const mode of modes) {
    if (!enabled.get(mode)) continue;
    try {
      const composition = await readers[mode]();
      if (rosterNotHorse > 0 && mode !== 'club_data_digest') composition.skipped.author_not_horse = rosterNotHorse;
      compositions.set(mode, composition);
    } catch (error) {
      const failed = emptyComposition();
      failed.skipped.failed = 1;
      failed.error = message(error);
      compositions.set(mode, failed);
    }
  }
  return { compositions, rosterNotHorse };
}

function previewDraft(draft: Phase6Draft): Phase6Draft & { author_is_horse: boolean } {
  // Horse drafts are only ever built for verified roster horses. A club digest
  // is authored by its page owner, who is a horse only when it is mirrored.
  return { ...draft, author_is_horse: draft.mode !== 'club_data_digest' || draft.publish === 'page_and_feed' };
}

export async function phase6Content(c: Context) {
  const preview = c.req.query('preview') === '1' || c.req.query('dry_run') === '1';
  const nowValue = c.req.query('at');
  const now = nowValue ? new Date(nowValue) : new Date();
  if (Number.isNaN(now.getTime())) return c.json({ success: false, error: 'invalid_at' }, 400);
  try {
    if (!preview && !(await engineEnabled())) {
      return c.json({ success: true, skipped: 'engine_disabled', modes_checked: 0, posted: 0 });
    }

    const modes: Phase6Mode[] = ['club_data_digest', 'local_event', 'seasonal_local'];
    const enabled = new Map<Phase6Mode, boolean>();
    for (const mode of modes) enabled.set(mode, preview ? true : await postModeEnabled(mode));

    // A disabled live mode is never composed. Preview is an explicit review
    // surface with no content writes, and is the only exception.
    const { compositions, rosterNotHorse } = await composePhase6(now, enabled, { preview });

    if (preview) {
      return c.json({
        success: true,
        preview: true,
        content_writes: 0,
        writes_note: PREVIEW_WRITES_NOTE,
        at: now.toISOString(),
        roster_not_horse: rosterNotHorse,
        candidates: Object.fromEntries(modes.map((mode) => [mode, compositions.get(mode)!.drafts.length])),
        skipped: Object.fromEntries(modes.map((mode) => [mode, compositions.get(mode)!.skipped])),
        errors: Object.fromEntries(modes.map((mode) => [mode, compositions.get(mode)!.error ?? null])),
        notes: Object.fromEntries(modes.map((mode) => [mode, compositions.get(mode)!.notes])),
        held: Object.fromEntries(modes.map((mode) => [mode, compositions.get(mode)!.held.map((item) => ({
          reason: item.reason,
          page_id: item.pageId,
          detail: item.detail,
          draft: item.draft ? previewDraft(item.draft) : null,
        }))])),
        samples: Object.fromEntries(modes.map((mode) => [mode, compositions.get(mode)!.drafts.slice(0, PREVIEW_LIMIT).map(previewDraft)])),
      });
    }

    const results: Record<string, unknown> = {};
    for (const mode of modes) {
      results[mode] = enabled.get(mode)
        ? await publishMode(mode, compositions.get(mode)!)
        : { skipped: 'awaiting_approval', posted: 0 };
    }
    let posted = 0;
    for (const value of Object.values(results)) {
      posted += Number((value as { posted?: number }).posted ?? 0);
    }
    return c.json({ success: true, preview: false, posted, results, timestamp: now.toISOString() });
  } catch (error) {
    const text = message(error);
    console.warn('[phase6-content] failed:', text);
    return c.json({ success: false, error: text }, 500);
  }
}
