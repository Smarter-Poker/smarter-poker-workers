/**
 * GET/POST /cron/phase6-content
 *
 * Builds Phase 6 data-native drafts from live club aggregates and the unified
 * local-event calendar. New publishing modes start disabled in
 * horse_post_modes. `?preview=1` is the only path that composes while a mode
 * is disabled, and it never writes. A scheduled call also obeys the fleet
 * master switch before reading a mode or producing copy.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { engineEnabled, loadFleet, postModeEnabled } from '../lib/content-engine/Fleet.js';
import { postedRecently } from '../lib/content-engine/HorsePublisher.js';
import { normalizePhrase, recordPhrase } from '../lib/content-engine/ContentLedger.js';
import {
  buildClubDigestDraft,
  buildClubTournamentResultDraft,
  buildLocalEventDraft,
  buildSeasonalDraft,
  type ClubPageRow,
  type ClubStatRow,
  type ClubTournamentRow,
  type ClubTournamentWinnerRow,
  type LocalEventRow,
  type LocalHorse,
  type MemberStatRow,
  type Phase6Draft,
  type Phase6Mode,
} from '../lib/content-engine/Phase6Content.js';

const PREVIEW_LIMIT = 24;
const PUBLISH_LIMIT_PER_MODE = 20;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

async function readClubDrafts(now: Date): Promise<Phase6Draft[]> {
  const supa = getSupabase();
  const through = isoDay(addDays(now, -1));
  const since = isoDay(addDays(now, -14));
  const [{ data: pages, error: pagesError }, { data: stats, error: statsError }] = await Promise.all([
    supa
      .from('social_pages')
      .select('id, owner_id, name, linked_entity_id, is_public')
      .eq('linked_entity_type', 'club')
      .eq('is_public', true)
      .not('linked_entity_id', 'is', null)
      .limit(500),
    supa
      .from('club_hand_daily')
      .select('club_id, stat_date, hands, pot_total')
      .gte('stat_date', since)
      .lte('stat_date', through)
      .order('stat_date', { ascending: false })
      .limit(5000),
  ]);
  if (pagesError) throw new Error(`club pages read failed: ${pagesError.message}`);
  if (statsError) throw new Error(`club stats read failed: ${statsError.message}`);
  const pageRows = (pages ?? []) as ClubPageRow[];
  const statRows = (stats ?? []) as ClubStatRow[];
  const drafts: Phase6Draft[] = [];
  const weekly = now.getUTCDay() === 1;
  for (const page of pageRows) {
    const ownStats = statRows.filter((row) => row.club_id === page.linked_entity_id);
    if (!ownStats.length) continue;
    const { data: members, error } = await supa
      .from('club_member_daily_stats')
      .select('club_id, stat_date, user_id, biggest_pot_won, profit')
      .eq('club_id', page.linked_entity_id)
      .gte('stat_date', weekly ? since : ownStats[0]!.stat_date)
      .lte('stat_date', through)
      .order('biggest_pot_won', { ascending: false, nullsFirst: false })
      .limit(100);
    if (error) throw new Error(`club member stats read failed: ${error.message}`);
    const memberRows = (members ?? []) as MemberStatRow[];
    const { data: leaderRows, error: leaderError } = await supa
      .from('club_member_daily_stats')
      .select('club_id, stat_date, user_id, biggest_pot_won, profit')
      .eq('club_id', page.linked_entity_id)
      .gte('stat_date', weekly ? since : ownStats[0]!.stat_date)
      .lte('stat_date', through)
      .gt('profit', 0)
      .limit(5000);
    if (leaderError) throw new Error(`club leader stats read failed: ${leaderError.message}`);
    const profitByUser = new Map<string, number>();
    for (const row of (leaderRows ?? []) as MemberStatRow[]) {
      if (row.user_id) profitByUser.set(row.user_id, (profitByUser.get(row.user_id) ?? 0) + Number(row.profit ?? 0));
    }
    const leaderPair = [...profitByUser.entries()].sort((a, b) => b[1] - a[1])[0];
    const leaderRow = leaderPair ? { user_id: leaderPair[0], profit: leaderPair[1] } : undefined;
    let leader: { user_id: string; display_name: string; profit: number } | null = null;
    if (leaderRow?.user_id) {
      const { data: profile, error: profileError } = await supa
        .from('profiles')
        .select('display_name, username')
        .eq('id', leaderRow.user_id)
        .maybeSingle();
      if (profileError) throw new Error(`club leader profile read failed: ${profileError.message}`);
      const displayName = String(profile?.display_name ?? profile?.username ?? '').trim();
      if (displayName) leader = { user_id: leaderRow.user_id, display_name: displayName, profit: Number(leaderRow.profit) };
    }
    const { data: jackpot, error: jackpotError } = await supa
      .from('bad_beat_jackpots')
      .select('id, current_amount')
      .eq('club_id', page.linked_entity_id)
      .eq('is_active', true)
      .order('current_amount', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (jackpotError) throw new Error(`club jackpot read failed: ${jackpotError.message}`);
    const draft = buildClubDigestDraft(page, ownStats, memberRows, weekly, { jackpot, leader });
    if (draft) drafts.push(draft);
  }

  const clubIds = pageRows.map((page) => page.linked_entity_id);
  if (clubIds.length > 0) {
    const { data: tournaments, error: tournamentError } = await supa
      .from('tournaments')
      .select('id, club_id, name, ended_at, prize_pool, current_players')
      .in('club_id', clubIds)
      .in('status', ['completed', 'finished'])
      .gte('ended_at', `${since}T00:00:00Z`)
      .lte('ended_at', `${through}T23:59:59Z`)
      .order('ended_at', { ascending: false })
      .limit(100);
    if (tournamentError) throw new Error(`club tournament results read failed: ${tournamentError.message}`);
    for (const tournament of (tournaments ?? []) as ClubTournamentRow[]) {
      const page = pageRows.find((row) => row.linked_entity_id === tournament.club_id);
      if (!page) continue;
      const { data: winner, error: winnerError } = await supa
        .from('tournament_players')
        .select('tournament_id, user_id, username, position, prize')
        .eq('tournament_id', tournament.id)
        .eq('position', 1)
        .limit(1)
        .maybeSingle();
      if (winnerError) throw new Error(`club tournament winner read failed: ${winnerError.message}`);
      const draft = buildClubTournamentResultDraft(page, tournament, winner as ClubTournamentWinnerRow | null);
      if (draft) drafts.push(draft);
    }
  }
  return drafts;
}

async function readLocalHorses(): Promise<LocalHorse[]> {
  const supa = getSupabase();
  const fleet = await loadFleet();
  const profileIds = fleet.map((horse) => horse.profile_id);
  const profiles: Array<{ id: string; city: string | null; state: string | null }> = [];
  for (let i = 0; i < profileIds.length; i += 200) {
    const { data, error } = await supa
      .from('profiles')
      .select('id, city, state')
      .in('id', profileIds.slice(i, i + 200));
    if (error) throw new Error(`horse locations read failed: ${error.message}`);
    profiles.push(...((data ?? []) as typeof profiles));
  }
  const locations = new Map(profiles.map((profile) => [profile.id, profile]));
  return fleet.map((horse) => ({
    profile_id: horse.profile_id,
    name: horse.name,
    city: locations.get(horse.profile_id)?.city ?? null,
    state: locations.get(horse.profile_id)?.state ?? null,
  }));
}

async function readLocalDrafts(now: Date, horses: LocalHorse[]): Promise<Phase6Draft[]> {
  const today = isoDay(now);
  const horizon = isoDay(addDays(now, 14));
  const { data, error } = await getSupabase()
    .from('unified_events_calendar')
    .select('source, native_id, venue_name, event_name, specific_date, start_time, city, state, is_active, is_suppressed')
    .eq('is_active', true)
    .eq('is_suppressed', false)
    .gte('specific_date', today)
    .lte('specific_date', horizon)
    .order('specific_date', { ascending: true })
    .limit(5000);
  if (error) throw new Error(`local events read failed: ${error.message}`);
  const events = (data ?? []) as LocalEventRow[];
  const candidates = horses
    .map((horse) => buildLocalEventDraft(horse, events, today, horizon))
    .filter((draft): draft is Phase6Draft => Boolean(draft));
  return [...new Map(candidates.map((draft) => [draft.publicationKey, draft])).values()];
}

function readSeasonalDrafts(now: Date, horses: LocalHorse[]): Phase6Draft[] {
  const candidates = horses
    .map((horse) => buildSeasonalDraft(horse, now))
    .filter((draft): draft is Phase6Draft => Boolean(draft));
  return [...new Map(candidates.map((draft) => [draft.publicationKey, draft])).values()];
}

async function alreadyPublished(publicationKey: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from('social_posts')
    .select('id')
    .eq('publication_key', publicationKey)
    .limit(1);
  if (error) throw new Error(`publication ledger read failed: ${error.message}`);
  return (data ?? []).length > 0;
}

async function publishClubDraft(draft: Phase6Draft): Promise<string> {
  const supa = getSupabase();
  const metadata = {
    scheduler: 'phase6',
    phase6_mode: draft.mode,
    publication_key: draft.publicationKey,
    grounding: draft.grounding,
  };
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
  if (pageError || !pagePost?.id) throw new Error(`club page post failed: ${pageError?.message ?? 'missing id'}`);
  const { data: feedPost, error: feedError } = await supa
    .from('social_posts')
    .insert({
      author_id: draft.authorId,
      content: draft.content,
      content_type: 'text',
      media_urls: [],
      visibility: 'public',
      publication_key: draft.publicationKey,
      metadata: { ...metadata, source: 'social_page_post', source_page_id: draft.pageId, source_post_id: pagePost.id },
    })
    .select('id')
    .maybeSingle();
  if (feedError || !feedPost?.id) {
    await supa.from('social_page_posts').delete().eq('id', pagePost.id);
    throw new Error(`club feed mirror failed; page post rolled back: ${feedError?.message ?? 'missing id'}`);
  }
  return feedPost.id;
}

async function publishHorseDraft(draft: Phase6Draft): Promise<string> {
  const { data, error } = await getSupabase()
    .from('social_posts')
    .insert({
      author_id: draft.authorId,
      content: draft.content,
      content_type: 'text',
      media_urls: [],
      visibility: 'public',
      link_url: draft.linkUrl ?? null,
      publication_key: draft.publicationKey,
      metadata: {
        scheduler: 'phase6',
        phase6_mode: draft.mode,
        source_id: draft.sourceId,
        grounding: draft.grounding,
      },
    })
    .select('id')
    .maybeSingle();
  if (error || !data?.id) throw new Error(`horse Phase 6 post failed: ${error?.message ?? 'missing id'}`);
  await recordPhrase(normalizePhrase(draft.content), draft.authorId, data.id);
  return data.id;
}

async function publishMode(mode: Phase6Mode, drafts: Phase6Draft[]): Promise<{ posted: number; duplicate: number; recent: number; failed: number; errors: string[] }> {
  const result = { posted: 0, duplicate: 0, recent: 0, failed: 0, errors: [] as string[] };
  for (const draft of drafts.slice(0, PUBLISH_LIMIT_PER_MODE)) {
    try {
      if (await alreadyPublished(draft.publicationKey)) {
        result.duplicate += 1;
        continue;
      }
      if (mode !== 'club_data_digest' && await postedRecently(draft.authorId)) {
        result.recent += 1;
        continue;
      }
      if (mode === 'club_data_digest') await publishClubDraft(draft);
      else await publishHorseDraft(draft);
      result.posted += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return result;
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

    // A disabled live mode is never composed. Preview is an explicit,
    // non-writing review surface and is the only exception.
    const needsHorses = enabled.get('local_event') || enabled.get('seasonal_local');
    const horses = needsHorses ? await readLocalHorses() : [];
    const drafts = new Map<Phase6Mode, Phase6Draft[]>([
      ['club_data_digest', enabled.get('club_data_digest') ? await readClubDrafts(now) : []],
      ['local_event', enabled.get('local_event') ? await readLocalDrafts(now, horses) : []],
      ['seasonal_local', enabled.get('seasonal_local') ? readSeasonalDrafts(now, horses) : []],
    ]);

    if (preview) {
      return c.json({
        success: true,
        preview: true,
        writes: 0,
        candidates: Object.fromEntries(modes.map((mode) => [mode, drafts.get(mode)!.length])),
        samples: Object.fromEntries(modes.map((mode) => [mode, drafts.get(mode)!.slice(0, PREVIEW_LIMIT)])),
      });
    }

    const results: Record<string, unknown> = {};
    for (const mode of modes) {
      results[mode] = enabled.get(mode)
        ? await publishMode(mode, drafts.get(mode)!)
        : { skipped: 'awaiting_approval', posted: 0 };
    }
    let posted = 0;
    for (const value of Object.values(results)) {
      posted += Number((value as { posted?: number }).posted ?? 0);
    }
    return c.json({ success: true, preview: false, posted, results, timestamp: now.toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[phase6-content] failed:', message);
    return c.json({ success: false, error: message }, 500);
  }
}
