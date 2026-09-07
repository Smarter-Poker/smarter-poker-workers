import { fleetHash } from './FleetScheduler.js';

export type Phase6Mode = 'club_data_digest' | 'local_event' | 'seasonal_local';

export interface ClubStatRow {
  club_id: string;
  stat_date: string;
  hands: number | null;
  pot_total: number | null;
}

export interface ClubPageRow {
  id: string;
  owner_id: string;
  name: string;
  linked_entity_id: string;
  is_public: boolean;
}

export interface MemberStatRow {
  club_id: string;
  stat_date: string;
  user_id?: string | null;
  biggest_pot_won: number | null;
  profit?: number | null;
}

export interface ClubDigestExtras {
  jackpot?: { id: string; current_amount: number | null } | null;
  leader?: { user_id: string; display_name: string; profit: number } | null;
}

export interface ClubTournamentRow {
  id: string;
  club_id: string;
  name: string;
  ended_at: string;
  prize_pool: number | null;
  current_players: number | null;
}

export interface ClubTournamentWinnerRow {
  tournament_id: string;
  user_id: string;
  username: string | null;
  position: number | null;
  prize: number | null;
}

export interface LocalEventRow {
  source: string;
  native_id: string;
  venue_name: string | null;
  event_name: string | null;
  specific_date: string | null;
  start_time: string | null;
  city: string | null;
  state: string | null;
  is_active: boolean | null;
  is_suppressed: boolean | null;
}

export interface LocalHorse {
  profile_id: string;
  name: string;
  city: string | null;
  state: string | null;
}

export interface Phase6Draft {
  mode: Phase6Mode;
  authorId: string;
  content: string;
  publicationKey: string;
  sourceId: string;
  pageId?: string;
  linkUrl?: string;
  grounding: string[];
}

const BAD_SOURCE_TEXT = /(?:agency_|iframe|javascript|undefined|unknown|untitled|null)/i;
const CLEAN_COPY = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF]/gu;

export function cleanSourceText(value: string | null | undefined, max = 120): string | null {
  const clean = String(value ?? '')
    .replace(CLEAN_COPY, '')
    .replace(/\u2014/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length < 3 || clean.length > max || BAD_SOURCE_TEXT.test(clean)) return null;
  return clean;
}

export function placeKey(city: string | null | undefined, state: string | null | undefined): string | null {
  const c = cleanSourceText(city, 80)?.toLowerCase();
  const s = String(state ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (s.length < 2 || s.length > 32 || BAD_SOURCE_TEXT.test(s)) return null;
  return c && s ? `${c}|${s}` : null;
}

function integer(value: number | null | undefined): number {
  return Math.max(0, Math.round(Number(value) || 0));
}

function readableDate(iso: string): string {
  const parsed = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(parsed);
}

function eventWhen(event: LocalEventRow, eventName: string): string {
  const date = readableDate(event.specific_date!);
  const time = cleanSourceText(event.start_time, 24);
  if (!time) return date;
  const compactTitle = eventName.toLowerCase().replace(/\s+/g, '');
  const compactTime = time.toLowerCase().replace(/\s+/g, '');
  return compactTitle.includes(compactTime) ? date : `${date} at ${time}`;
}

function localEventCopy(seed: string, eventName: string, venue: string, city: string, when: string): string {
  const frames = [
    `${eventName} is on the calendar at ${venue} here in ${city} on ${when}.`,
    `A local one for the calendar: ${eventName} at ${venue} on ${when}.`,
    `${venue} has ${eventName} coming up on ${when}. That is right here in ${city}.`,
    `Poker around ${city}: ${eventName} is set for ${venue} on ${when}.`,
    `${eventName} lands at ${venue} on ${when}. Local players in ${city} may want to take a look.`,
    `One from the local schedule in ${city}: ${eventName}, ${venue}, ${when}.`,
    `The ${city} calendar has ${eventName} at ${venue} on ${when}.`,
    `For players near ${city}, ${eventName} is listed at ${venue} on ${when}.`,
    `A poker date to know around ${city}: ${eventName} at ${venue} on ${when}.`,
    `${venue} is hosting ${eventName} on ${when}. It is a local option for ${city} players.`,
    `Coming up in ${city}: ${eventName} at ${venue} on ${when}.`,
    `The next local listing I spotted is ${eventName} at ${venue} on ${when}.`,
  ];
  return frames[fleetHash(seed, 'phase6-local-copy') % frames.length]!;
}

export function buildClubDigestDraft(
  page: ClubPageRow,
  stats: ClubStatRow[],
  memberStats: MemberStatRow[],
  weekly: boolean,
  extras: ClubDigestExtras = {},
): Phase6Draft | null {
  const clubName = cleanSourceText(page.name, 80);
  if (!clubName || !page.is_public || !page.owner_id || !page.linked_entity_id || stats.length === 0) return null;
  const ordered = [...stats].sort((a, b) => b.stat_date.localeCompare(a.stat_date));
  const period = weekly ? ordered.slice(0, 7) : ordered.slice(0, 1);
  const hands = period.reduce((sum, row) => sum + integer(row.hands), 0);
  const chipsMoved = period.reduce((sum, row) => sum + integer(row.pot_total), 0);
  const dates = new Set(period.map((row) => row.stat_date));
  const biggestPot = Math.max(
    0,
    ...memberStats
      .filter((row) => row.club_id === page.linked_entity_id && dates.has(row.stat_date))
      .map((row) => integer(row.biggest_pot_won)),
  );
  if (hands <= 0) return null;
  const label = weekly ? 'Weekly club digest' : `Club table report for ${readableDate(period[0]!.stat_date)}`;
  const pieces = [`${label}: ${clubName} dealt ${hands.toLocaleString('en-US')} hands`];
  if (chipsMoved > 0) pieces.push(`${chipsMoved.toLocaleString('en-US')} chips moved through the pots`);
  if (biggestPot > 0) pieces.push(`the biggest recorded pot was ${biggestPot.toLocaleString('en-US')} chips`);
  const jackpot = integer(extras.jackpot?.current_amount);
  if (jackpot > 0) pieces.push(`the active bad beat jackpot stands at ${jackpot.toLocaleString('en-US')} chips`);
  if (extras.leader && extras.leader.profit > 0) {
    const leaderName = cleanSourceText(extras.leader.display_name, 80);
    if (leaderName) pieces.push(`${leaderName} leads the period at +${integer(extras.leader.profit).toLocaleString('en-US')} chips`);
  }
  const content = `${pieces.join(', ')}.`;
  const periodKey = weekly ? `${period.at(-1)!.stat_date}:${period[0]!.stat_date}` : period[0]!.stat_date;
  return {
    mode: 'club_data_digest',
    authorId: page.owner_id,
    pageId: page.id,
    content,
    publicationKey: `phase6:club:${weekly ? 'week' : 'day'}:${page.linked_entity_id}:${periodKey}`,
    sourceId: page.linked_entity_id,
    grounding: [
      ...period.map((row) => `club_hand_daily:${row.club_id}:${row.stat_date}`),
      ...(extras.jackpot ? [`bad_beat_jackpots:${extras.jackpot.id}`] : []),
      ...(extras.leader ? [`club_member_daily_stats:${extras.leader.user_id}:${periodKey}`] : []),
    ],
  };
}

export function buildClubTournamentResultDraft(
  page: ClubPageRow,
  tournament: ClubTournamentRow,
  winner: ClubTournamentWinnerRow | null,
): Phase6Draft | null {
  const clubName = cleanSourceText(page.name, 80);
  const tournamentName = cleanSourceText(tournament.name, 120);
  if (!clubName || !tournamentName || !page.is_public || tournament.club_id !== page.linked_entity_id) return null;
  const winnerName = cleanSourceText(winner?.username, 80);
  const facts = [`${tournamentName} is complete at ${clubName}`];
  if (winnerName && winner?.position === 1) facts.push(`${winnerName} finished first`);
  const prize = integer(winner?.prize);
  if (prize > 0) facts.push(`the first-place prize was ${prize.toLocaleString('en-US')} chips`);
  const field = integer(tournament.current_players);
  if (field > 0) facts.push(`${field.toLocaleString('en-US')} players entered`);
  const pool = integer(tournament.prize_pool);
  if (pool > 0) facts.push(`the prize pool was ${pool.toLocaleString('en-US')} chips`);
  return {
    mode: 'club_data_digest',
    authorId: page.owner_id,
    pageId: page.id,
    content: `${facts.join(', ')}.`,
    publicationKey: `phase6:club:tournament:${tournament.id}`,
    sourceId: tournament.id,
    grounding: [
      `tournaments:${tournament.id}`,
      ...(winner ? [`tournament_players:${tournament.id}:${winner.user_id}`] : []),
    ],
  };
}

export function validLocalEvent(event: LocalEventRow, todayIso: string, horizonIso: string): boolean {
  return event.is_active === true
    && event.is_suppressed !== true
    && Boolean(cleanSourceText(event.event_name))
    && Boolean(cleanSourceText(event.venue_name))
    && Boolean(placeKey(event.city, event.state))
    && Boolean(event.specific_date && event.specific_date >= todayIso && event.specific_date <= horizonIso);
}

export function buildLocalEventDraft(
  horse: LocalHorse,
  events: LocalEventRow[],
  todayIso: string,
  horizonIso: string,
): Phase6Draft | null {
  const home = placeKey(horse.city, horse.state);
  if (!home) return null;
  const matching = events.filter((event) => placeKey(event.city, event.state) === home && validLocalEvent(event, todayIso, horizonIso));
  if (matching.length === 0) return null;
  const event = matching[fleetHash(`${horse.profile_id}:${todayIso}`, 'phase6-local') % matching.length]!;
  const eventName = cleanSourceText(event.event_name)!;
  const venue = cleanSourceText(event.venue_name)!;
  const city = cleanSourceText(event.city)!;
  const when = eventWhen(event, eventName);
  return {
    mode: 'local_event',
    authorId: horse.profile_id,
    content: localEventCopy(`${horse.profile_id}:${event.source}:${event.native_id}`, eventName, venue, city, when),
    // One platform post per real-world event. A horse is the local voice, not
    // a reason to repeat the same listing across hundreds of profiles.
    publicationKey: `phase6:local:${event.source}:${event.native_id}`,
    sourceId: `${event.source}:${event.native_id}`,
    linkUrl: '/hub/poker-near-me',
    grounding: [`unified_events_calendar:${event.source}:${event.native_id}`],
  };
}

const CITY_TEAMS: Record<string, { football?: string; hockey?: string; basketball?: string }> = {
  'las vegas|nv': { football: 'Raiders', hockey: 'Golden Knights' },
  'dallas|tx': { football: 'Cowboys', basketball: 'Mavericks' },
  'chicago|il': { football: 'Bears', hockey: 'Blackhawks', basketball: 'Bulls' },
  'miami|fl': { football: 'Dolphins', basketball: 'Heat' },
  'philadelphia|pa': { football: 'Eagles', hockey: 'Flyers', basketball: '76ers' },
  'new york|ny': { football: 'Giants', hockey: 'Rangers', basketball: 'Knicks' },
  'los angeles|ca': { football: 'Rams', hockey: 'Kings', basketball: 'Lakers' },
};

export function buildSeasonalDraft(horse: LocalHorse, now: Date): Phase6Draft | null {
  const home = placeKey(horse.city, horse.state);
  const teams = home ? CITY_TEAMS[home] : undefined;
  if (!home || !teams) return null;
  const month = now.getUTCMonth() + 1;
  const dateKey = now.toISOString().slice(0, 10);
  let sport: keyof typeof teams | null = null;
  if (month >= 9 || month <= 2) sport = 'football';
  else if (month >= 4 && month <= 6) sport = 'basketball';
  else if (month >= 10 || month <= 4) sport = 'hockey';
  const team = sport ? teams[sport] : null;
  if (!team || !sport) return null;
  const city = cleanSourceText(horse.city)!;
  const frames = [
    `${sport[0]!.toUpperCase()}${sport.slice(1)} season is back in the conversation around ${city}. I will be keeping an eye on the ${team}.`,
    `${city} has plenty to talk about with the ${team} in season. I am following along.`,
    `The ${team} are part of the local conversation in ${city} this month. I have them on my radar.`,
    `It is ${team} season around ${city}. I will be watching how it develops.`,
  ];
  const content = frames[fleetHash(`${home}:${dateKey.slice(0, 7)}:${sport}`, 'phase6-season-copy') % frames.length]!;
  return {
    mode: 'seasonal_local',
    authorId: horse.profile_id,
    content,
    // Seasonal context is shared by a city. Publish it once per city/team,
    // rather than making every horse in that city say the same thing.
    publicationKey: `phase6:season:${dateKey.slice(0, 7)}:${sport}:${home}`,
    sourceId: `calendar:${dateKey.slice(0, 7)}:${sport}:${home}`,
    grounding: [`calendar:${dateKey.slice(0, 7)}`, `city_team:${home}:${team}`],
  };
}
