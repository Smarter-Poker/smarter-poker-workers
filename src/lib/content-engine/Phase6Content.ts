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
  club_id?: string;
  table_id?: string | null;
  stat_date: string;
  user_id?: string | null;
  biggest_pot_won: number | null;
  profit?: number | null;
}

/** The exact stat period a club digest reports on (inclusive ISO dates). */
export interface ClubDigestPeriod {
  start: string;
  end: string;
  weekly: boolean;
}

/**
 * Facts the route established for one club and one period from a complete
 * read. Anything the route could not establish exactly is null and is left
 * out of the copy rather than approximated.
 */
export interface ClubPeriodFacts {
  biggestPot?: number | null;
  /** Only ever a roster horse that is the single top net earner of the period. */
  leader?: { user_id: string; display_name: string; profit: number } | null;
  jackpot?: { id: string; current_amount: number | null } | null;
  memberRows?: number | null;
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
  /** Normalized city|state the draft is about (local modes). */
  place?: string;
  /** Normalized venue the draft is about (local_event). */
  venue?: string;
}

const BAD_SOURCE_TEXT = /(?:agency_|iframe|javascript|undefined|unknown|untitled|null)/i;
const CLEAN_COPY = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF]/gu;

export function cleanSourceText(value: string | null | undefined, max = 120): string | null {
  const clean = String(value ?? '')
    .replace(CLEAN_COPY, '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length < 3 || clean.length > max || BAD_SOURCE_TEXT.test(clean)) return null;
  return clean;
}

/**
 * Scraped page furniture that reached the calendar as an "event name", such as
 * `slider-item slick-slide`. Real listings carry capitals, digits or poker
 * words; carousel classes, markup and all-lowercase hyphenated class tokens do
 * not belong in a post.
 */
const MARKUP_TEXT = /<[^>]*>|&[a-z]+;|[{}]|\b(?:class|href|onclick|style)\s*=|\bdata-[a-z]/i;
const CLASS_WORDS = /\b(?:slick|slider|swiper|carousel|elementor|wp-block|navbar|dropdown|nbsp|div|span|img|svg|css|col-(?:xs|sm|md|lg|xl))\b/i;
const CLASS_TOKEN = /^[a-z]+(?:[-_][a-z0-9]+)+$/;

export function isJunkSourceText(value: string | null | undefined): boolean {
  const text = String(value ?? '').trim();
  if (!text) return true;
  if (MARKUP_TEXT.test(text) || CLASS_WORDS.test(text)) return true;
  const tokens = text.split(/\s+/);
  // Every word lowercase and at least one hyphenated or underscored class token.
  if (!/[A-Z0-9$]/.test(text) && tokens.some((token) => CLASS_TOKEN.test(token))) return true;
  return false;
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

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const WEEKDAY_FORMAT = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' });

function readableDate(iso: string): string {
  const parsed = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return DATE_FORMAT.format(parsed);
}

function weekdayName(iso: string): string {
  return WEEKDAY_FORMAT.format(new Date(`${iso}T12:00:00Z`));
}

function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T12:00:00Z`) - Date.parse(`${fromIso}T12:00:00Z`)) / 86_400_000);
}

// ---------------------------------------------------------------------------
// club_data_digest
// ---------------------------------------------------------------------------

/**
 * One digest per club and exact period. Hands and chips come from the club's
 * daily aggregate rows inside the period; the biggest pot and the leader are
 * included only when the route established them exactly (see ClubPeriodFacts).
 */
export function buildClubDigestDraft(
  page: ClubPageRow,
  stats: ClubStatRow[],
  period: ClubDigestPeriod,
  facts: ClubPeriodFacts = {},
): Phase6Draft | null {
  const clubName = cleanSourceText(page.name, 80);
  if (!clubName || !page.is_public || !page.owner_id || !page.linked_entity_id) return null;
  if (!period.start || !period.end || period.start > period.end) return null;
  if (!period.weekly && period.start !== period.end) return null;
  const inPeriod = stats.filter((row) => row.club_id === page.linked_entity_id
    && row.stat_date >= period.start && row.stat_date <= period.end);
  if (inPeriod.length === 0) return null;
  const hands = inPeriod.reduce((sum, row) => sum + integer(row.hands), 0);
  const chipsMoved = inPeriod.reduce((sum, row) => sum + integer(row.pot_total), 0);
  if (hands <= 0) return null;

  const sentences: string[] = [];
  if (period.weekly) {
    sentences.push(chipsMoved > 0
      ? `${clubName} put up ${formatCount(hands)} hands between ${readableDate(period.start)} and ${readableDate(period.end)}, and ${formatCount(chipsMoved)} chips went through the pots.`
      : `${clubName} put up ${formatCount(hands)} hands between ${readableDate(period.start)} and ${readableDate(period.end)}.`);
  } else {
    sentences.push(chipsMoved > 0
      ? `${clubName} dealt ${formatCount(hands)} hands on ${readableDate(period.end)}, and ${formatCount(chipsMoved)} chips went through the pots.`
      : `${clubName} dealt ${formatCount(hands)} hands on ${readableDate(period.end)}.`);
  }
  const biggestPot = integer(facts.biggestPot);
  if (biggestPot > 0) sentences.push(`Biggest pot of the ${period.weekly ? 'week' : 'day'} was ${formatCount(biggestPot)} chips.`);
  const jackpot = integer(facts.jackpot?.current_amount);
  if (jackpot > 0) sentences.push(`The bad beat jackpot's sitting at ${formatCount(jackpot)} chips.`);
  const leaderName = facts.leader ? cleanSourceText(facts.leader.display_name, 40) : null;
  const leaderProfit = integer(facts.leader?.profit);
  if (facts.leader && leaderName && leaderProfit > 0) {
    sentences.push(period.weekly
      ? `${leaderName} finished the week on top of the club at +${formatCount(leaderProfit)}.`
      : `${leaderName} had the best day in the club at +${formatCount(leaderProfit)}.`);
  }
  const periodKey = period.weekly ? `${period.start}:${period.end}` : period.end;
  return {
    mode: 'club_data_digest',
    authorId: page.owner_id,
    pageId: page.id,
    content: sentences.join(' '),
    publicationKey: `phase6:club:${period.weekly ? 'week' : 'day'}:${page.linked_entity_id}:${periodKey}`,
    sourceId: page.linked_entity_id,
    grounding: [
      ...inPeriod
        .map((row) => `club_hand_daily:${row.club_id}:${row.stat_date}`)
        .sort(),
      ...(biggestPot > 0 || (facts.leader && leaderName)
        ? [`club_member_daily_stats:${page.linked_entity_id}:${period.start}..${period.end}:rows=${facts.memberRows ?? 'unknown'}`]
        : []),
      ...(jackpot > 0 && facts.jackpot ? [`bad_beat_jackpots:${facts.jackpot.id}`] : []),
      ...(facts.leader && leaderName ? [`leader:${facts.leader.user_id}:net=${facts.leader.profit}`] : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// local_event
// ---------------------------------------------------------------------------

/** Primary IANA zone per US state; used only to say today/tonight/tomorrow. */
const STATE_TZ: Record<string, string> = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago',
  CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DC: 'America/New_York',
  DE: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu',
  IA: 'America/Chicago', ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis',
  KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', MA: 'America/New_York',
  MD: 'America/New_York', ME: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago',
  MO: 'America/Chicago', MS: 'America/Chicago', MT: 'America/Denver', NC: 'America/New_York',
  ND: 'America/Chicago', NE: 'America/Chicago', NH: 'America/New_York', NJ: 'America/New_York',
  NM: 'America/Denver', NV: 'America/Los_Angeles', NY: 'America/New_York', OH: 'America/New_York',
  OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago',
  UT: 'America/Denver', VA: 'America/New_York', VT: 'America/New_York', WA: 'America/Los_Angeles',
  WI: 'America/Chicago', WV: 'America/New_York', WY: 'America/Denver',
};

/** A listing that starts within this many minutes is too close to announce. */
const START_MARGIN_MINUTES = 60;
/**
 * Listings before 7AM (`12AM`, `6AM $10000 Buy In`) are scraper artifacts far
 * more often than real start times, and `tomorrow at 12AM` misleads either way.
 */
const EARLIEST_START_MINUTES = 7 * 60;
const EVENING_MINUTES = 17 * 60;

const TIME_TOKEN = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])\.?m\.?(?![a-z])/gi;
const MONEY_TOKEN = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?/g;
const GUARANTEE = /\$\s?\d[\d,.]*\s*[km]\b|\bgtd\b|\bguarantee/i;
const BUY_IN_WORDS = /\bbuy[\s-]?ins?\b/gi;

/** Minutes after midnight for a clock string such as `8:00PM`, `4PM` or `6:15 pm`. */
export function parseClock(value: string | null | undefined): number | null {
  const match = String(value ?? '').trim().match(/^(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])\.?m\.?$/i);
  if (!match) return null;
  let hours = Number(match[1]) % 12;
  if (match[3]!.toLowerCase() === 'p') hours += 12;
  return hours * 60 + Number(match[2] ?? 0);
}

function formatClock(minutes: number): string {
  const hours24 = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const suffix = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return mins === 0 ? `${hours12}${suffix}` : `${hours12}:${String(mins).padStart(2, '0')}${suffix}`;
}

export interface ParsedEventTitle {
  game: string;
  buyIn: number | null;
  titleMinutes: number | null;
}

/**
 * Calendar titles are often `No Limit Hold'em 8:00PM $160 Buy In`. Split them
 * into the game, the buy-in and the time so the copy can say them the way a
 * player would. Returns null when the title has no game left, or carries more
 * than one buy-in or time and so cannot be read unambiguously.
 */
export function parseEventTitle(title: string): ParsedEventTitle | null {
  const times = [...title.matchAll(TIME_TOKEN)].map((match) => parseClock(match[0].replace(/\s+/g, '')));
  const distinctTimes = [...new Set(times)];
  if (distinctTimes.length > 1 || distinctTimes.includes(null)) return null;
  let rest = title.replace(TIME_TOKEN, ' ');
  let buyIn: number | null = null;
  if (GUARANTEE.test(title)) {
    // A guarantee reads as part of the name. A separate buy-in beside it is
    // too tangled to restate without risking a wrong number.
    if (/\bbuy[\s-]?ins?\b/i.test(title)) return null;
  } else {
    const amounts = [...rest.matchAll(MONEY_TOKEN)];
    if (amounts.length > 1) return null;
    // Only an amount the title presents as the buy-in is one: `$160 Buy In`
    // or a leading `$250 NLH`. `Satellite to $1,100` keeps its amount in the name.
    const explicit = /\$\s?[\d,]+(?:\.\d{2})?\s*buy[\s-]?in\b/i.test(rest) || /^\s*\$/.test(rest);
    if (amounts.length === 1 && explicit) {
      const amount = Number(amounts[0]![1]!.replace(/,/g, ''));
      if (amount > 0) buyIn = amount;
      rest = rest.replace(MONEY_TOKEN, ' ');
    }
    rest = rest.replace(BUY_IN_WORDS, ' ');
  }
  const game = rest
    .replace(/[\u2022\u00b7|]/g, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:@/+-]+|[\s,;:@/+-]+$/g, '')
    .trim();
  if (!/[A-Za-z]{2,}/.test(game)) return null;
  // A clock with no AM or PM (`8:30`) cannot be restated honestly.
  if (/\b\d{1,2}:\d{2}\b/.test(game)) return null;
  return { game, buyIn, titleMinutes: distinctTimes[0] ?? null };
}

export function tidyVenueName(value: string): string {
  // `Casino Miami Jai-Alai Casino` is a scraper join of name and type.
  return /^casino\s.+\scasino$/i.test(value) ? value.replace(/\s+casino$/i, '') : value;
}

const ZONE_FORMATS = new Map<string, Intl.DateTimeFormat>();

function localClock(at: Date, timeZone: string): { date: string; minutes: number } {
  let format = ZONE_FORMATS.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    ZONE_FORMATS.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export interface LocalEventFacts {
  game: string;
  venue: string;
  city: string;
  buyIn: number | null;
  startMinutes: number | null;
  when: string;
}

/**
 * Everything the copy may say about one listing, or null when the listing
 * cannot be announced honestly right now: junk text, an unreadable title, a
 * time that disagrees with the title, a listing already under way, or a
 * same-day listing whose start time or local clock is unknown.
 */
export function localEventFacts(event: LocalEventRow, now: Date): LocalEventFacts | null {
  const title = cleanSourceText(event.event_name);
  const venueName = cleanSourceText(event.venue_name);
  const city = cleanSourceText(event.city, 80);
  if (!title || !venueName || !city || !event.specific_date) return null;
  if (isJunkSourceText(title) || isJunkSourceText(venueName)) return null;
  const parsed = parseEventTitle(title);
  if (!parsed) return null;
  const columnMinutes = parseClock(event.start_time);
  if (columnMinutes !== null && parsed.titleMinutes !== null && columnMinutes !== parsed.titleMinutes) return null;
  const startMinutes = columnMinutes ?? parsed.titleMinutes;
  if (startMinutes !== null && startMinutes < EARLIEST_START_MINUTES) return null;
  const at = startMinutes === null ? '' : ` at ${formatClock(startMinutes)}`;
  const date = event.specific_date;
  const zone = STATE_TZ[String(event.state ?? '').trim().toUpperCase()];
  let when: string;
  if (!zone) {
    if (date <= now.toISOString().slice(0, 10)) return null;
    when = `on ${readableDate(date)}${at}`;
  } else {
    const local = localClock(now, zone);
    const ahead = daysBetween(local.date, date);
    if (ahead < 0) return null;
    if (ahead === 0) {
      if (startMinutes === null || startMinutes <= local.minutes + START_MARGIN_MINUTES) return null;
      when = `${startMinutes >= EVENING_MINUTES ? 'tonight' : 'today'}${at}`;
    } else if (ahead === 1) {
      when = `tomorrow${startMinutes !== null && startMinutes >= EVENING_MINUTES ? ' night' : ''}${at}`;
    } else if (ahead <= 6) {
      when = `${weekdayName(date)}${at}`;
    } else {
      when = `on ${readableDate(date)}${at}`;
    }
  }
  // A series row carries its first day, not a single sitting.
  if (event.source === 'series') when = `starting ${when.replace(/^on /, '')}`;
  return { game: parsed.game, venue: tidyVenueName(venueName), city, buyIn: parsed.buyIn, startMinutes, when };
}

function localEventCopy(seed: string, facts: LocalEventFacts): string {
  const { game, venue, city, when } = facts;
  const buyIn = facts.buyIn ? `$${formatCount(facts.buyIn)}` : null;
  const tail = buyIn ? `, ${buyIn} buy-in` : '';
  const frames = [
    `${venue} has ${game} ${when}${tail}. Anybody from ${city} going?`,
    `Heads up ${city}: ${game} at ${venue} ${when}${tail}.`,
    `If you're around ${city}, ${venue} has ${game} ${when}${tail}. Could be a fun one.`,
    `Looks like ${venue} is running ${game} ${when}${tail}. Worth a look if you're in ${city}.`,
    `${game} at ${venue} ${when}${tail}. Any ${city} regulars playing it?`,
    `Anyone else eyeing ${game} at ${venue} ${when}?${buyIn ? ` It's a ${buyIn} buy-in.` : ''}`,
    `${city} players, ${venue} has ${game} ${when}${tail}. I'd play that.`,
  ];
  const text = frames[fleetHash(seed, 'phase6-local-copy') % frames.length]!;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function validLocalEvent(event: LocalEventRow, todayIso: string, horizonIso: string): boolean {
  return event.is_active === true
    && event.is_suppressed !== true
    && Boolean(cleanSourceText(event.event_name))
    && Boolean(cleanSourceText(event.venue_name))
    && !isJunkSourceText(event.event_name)
    && !isJunkSourceText(event.venue_name)
    && Boolean(placeKey(event.city, event.state))
    && Boolean(event.specific_date && event.specific_date >= todayIso && event.specific_date <= horizonIso);
}

function venueKey(event: LocalEventRow): string {
  return `${String(event.venue_name ?? '').trim().toLowerCase()}|${placeKey(event.city, event.state)}`;
}

/**
 * One listing for one horse. The horse picks a venue in its own city first and
 * then a listing at that venue, so a venue with many listings does not crowd
 * out the rest of the city.
 */
export function buildLocalEventDraft(
  horse: LocalHorse,
  events: LocalEventRow[],
  todayIso: string,
  horizonIso: string,
  now: Date,
  /** Optional per-run memo: a listing's facts do not depend on the horse. */
  factsCache?: Map<LocalEventRow, LocalEventFacts | null>,
): Phase6Draft | null {
  const home = placeKey(horse.city, horse.state);
  if (!home) return null;
  const usable: Array<{ event: LocalEventRow; facts: LocalEventFacts }> = [];
  for (const event of events) {
    if (placeKey(event.city, event.state) !== home || !validLocalEvent(event, todayIso, horizonIso)) continue;
    let facts = factsCache?.get(event);
    if (facts === undefined) {
      facts = localEventFacts(event, now);
      factsCache?.set(event, facts);
    }
    if (facts) usable.push({ event, facts });
  }
  if (usable.length === 0) return null;
  const venues = [...new Set(usable.map((item) => venueKey(item.event)))].sort();
  const seed = `${horse.profile_id}:${todayIso}`;
  const venue = venues[fleetHash(seed, 'phase6-local-venue') % venues.length]!;
  const pool = usable.filter((item) => venueKey(item.event) === venue);
  const { event, facts } = pool[fleetHash(seed, 'phase6-local') % pool.length]!;
  return {
    mode: 'local_event',
    authorId: horse.profile_id,
    content: localEventCopy(`${horse.profile_id}:${event.source}:${event.native_id}`, facts),
    // One platform post per real-world event. A horse is the local voice, not
    // a reason to repeat the same listing across hundreds of profiles.
    publicationKey: `phase6:local:${event.source}:${event.native_id}`,
    sourceId: `${event.source}:${event.native_id}`,
    linkUrl: '/hub/poker-near-me',
    grounding: [`unified_events_calendar:${event.source}:${event.native_id}`],
    place: home,
    venue,
  };
}

/**
 * Publish order for local drafts: rotate through cities, and inside a city
 * through venues, so the first posts of a run are not one venue or one city.
 */
export function spreadLocalDrafts(drafts: Phase6Draft[]): Phase6Draft[] {
  const byPlace = new Map<string, Map<string, Phase6Draft[]>>();
  for (const draft of drafts) {
    const place = draft.place ?? '';
    const venue = draft.venue ?? draft.sourceId;
    if (!byPlace.has(place)) byPlace.set(place, new Map());
    const venues = byPlace.get(place)!;
    if (!venues.has(venue)) venues.set(venue, []);
    venues.get(venue)!.push(draft);
  }
  const roundRobin = (lists: Phase6Draft[][]): Phase6Draft[] => {
    const out: Phase6Draft[] = [];
    for (let i = 0; ; i += 1) {
      let any = false;
      for (const list of lists) {
        if (i < list.length) {
          out.push(list[i]!);
          any = true;
        }
      }
      if (!any) return out;
    }
  };
  return roundRobin([...byPlace.values()].map((venues) => roundRobin([...venues.values()])));
}

// ---------------------------------------------------------------------------
// seasonal_local
// ---------------------------------------------------------------------------

export type Sport = 'football' | 'baseball' | 'hockey' | 'basketball';

/** Static team-city facts for the cities the fleet lives in (2026). */
const CITY_TEAMS: Record<string, Partial<Record<Sport, string>>> = {
  'las vegas|nv': { football: 'Raiders', hockey: 'Golden Knights' },
  'los angeles|ca': { football: 'Rams', baseball: 'Dodgers', hockey: 'Kings', basketball: 'Lakers' },
  'san francisco|ca': { football: '49ers', baseball: 'Giants', basketball: 'Warriors' },
  'new york|ny': { football: 'Giants', baseball: 'Yankees', hockey: 'Rangers', basketball: 'Knicks' },
  'miami|fl': { football: 'Dolphins', baseball: 'Marlins', basketball: 'Heat' },
  'chicago|il': { football: 'Bears', baseball: 'Cubs', hockey: 'Blackhawks', basketball: 'Bulls' },
  'houston|tx': { football: 'Texans', baseball: 'Astros', basketball: 'Rockets' },
  'dallas|tx': { football: 'Cowboys', hockey: 'Stars', basketball: 'Mavericks' },
  'phoenix|az': { football: 'Cardinals', baseball: 'Diamondbacks', basketball: 'Suns' },
  'portland|or': { basketball: 'Trail Blazers' },
  'boston|ma': { football: 'Patriots', baseball: 'Red Sox', hockey: 'Bruins', basketball: 'Celtics' },
  'seattle|wa': { football: 'Seahawks', baseball: 'Mariners', hockey: 'Kraken' },
  'tampa|fl': { football: 'Buccaneers', baseball: 'Rays', hockey: 'Lightning' },
  'new orleans|la': { football: 'Saints', basketball: 'Pelicans' },
  'denver|co': { football: 'Broncos', baseball: 'Rockies', hockey: 'Avalanche', basketball: 'Nuggets' },
  'san diego|ca': { baseball: 'Padres' },
  'minneapolis|mn': { football: 'Vikings', baseball: 'Twins', hockey: 'Wild', basketball: 'Timberwolves' },
  'detroit|mi': { football: 'Lions', baseball: 'Tigers', hockey: 'Red Wings', basketball: 'Pistons' },
  'pittsburgh|pa': { football: 'Steelers', baseball: 'Pirates', hockey: 'Penguins' },
  'nashville|tn': { football: 'Titans', hockey: 'Predators' },
  'charlotte|nc': { football: 'Panthers', basketball: 'Hornets' },
  'atlanta|ga': { football: 'Falcons', baseball: 'Braves', basketball: 'Hawks' },
  'salt lake city|ut': { basketball: 'Jazz' },
  'philadelphia|pa': { football: 'Eagles', baseball: 'Phillies', hockey: 'Flyers', basketball: '76ers' },
};

/**
 * Regular-season windows as [MMDD start, MMDD end], each drawn inside every
 * recent season's real dates, so "it's X season" is true on the date with no
 * schedule lookup. NFL runs early Sep to early Jan (regular season), MLB late
 * Mar to late Sep, NHL early Oct to mid Apr, NBA late Oct to mid Apr.
 */
const SEASON_WINDOWS: Record<Sport, Array<[number, number]>> = {
  football: [[915, 1228]],
  baseball: [[405, 925]],
  hockey: [[1015, 1231], [101, 405]],
  basketball: [[1028, 1231], [101, 405]],
};

export function sportsInSeason(now: Date): Sport[] {
  const mmdd = (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  return (Object.keys(SEASON_WINDOWS) as Sport[])
    .filter((sport) => SEASON_WINDOWS[sport].some(([start, end]) => mmdd >= start && mmdd <= end));
}

function seasonalCopy(seed: string, sport: Sport, team: string, city: string): string {
  const frames: Record<Sport, string[]> = {
    football: [
      `Football's rolling in ${city}. I'll be sneaking looks at the ${team} score between hands.`,
      `It's ${team} season around ${city}. Anybody else trying to follow the game and play a big pot at the same time?`,
      `Football's back on in ${city}. Rooting for the ${team} and trying not to let it tilt me at the tables.`,
    ],
    baseball: [
      `Still baseball season in ${city}. I'll take a ${team} game on in the background over a quiet card room any day.`,
      `${team} baseball's still going in ${city}. Anybody else keeping one eye on the score while they play?`,
      `It's still ${team} season in ${city}. A ballgame on and a few orbits to play sounds about right.`,
    ],
    hockey: [
      `Hockey's on in ${city}. I'll have the ${team} on somewhere while I play.`,
      `It's ${team} season in ${city}. Watching hockey and playing a tough spot at the same time is a skill I'm still working on.`,
      `${team} hockey's on in ${city}. Anybody else sweating a game and a session at once?`,
    ],
    basketball: [
      `${team} basketball's on in ${city}. Somebody tell me how to play a big pot and watch a close game at the same time.`,
      `It's ${team} season in ${city}. Hoops in the background, cards in front of me. Can't complain.`,
      `Basketball's on in ${city}. Anybody else keeping the ${team} on while they play?`,
    ],
  };
  const options = frames[sport];
  return options[fleetHash(seed, 'phase6-season-copy') % options.length]!;
}

export function buildSeasonalDraft(horse: LocalHorse, now: Date): Phase6Draft | null {
  const home = placeKey(horse.city, horse.state);
  const teams = home ? CITY_TEAMS[home] : undefined;
  if (!home || !teams) return null;
  const month = now.toISOString().slice(0, 7);
  const sports = sportsInSeason(now).filter((sport) => Boolean(teams[sport]));
  if (sports.length === 0) return null;
  const sport = sports[fleetHash(`${home}:${month}`, 'phase6-season-sport') % sports.length]!;
  const team = teams[sport]!;
  const city = cleanSourceText(horse.city, 80);
  if (!city) return null;
  return {
    mode: 'seasonal_local',
    authorId: horse.profile_id,
    content: seasonalCopy(`${home}:${month}:${sport}`, sport, team, city),
    // Seasonal context is shared by a city. Publish it once per city/team,
    // rather than making every horse in that city say the same thing.
    publicationKey: `phase6:season:${month}:${sport}:${home}`,
    sourceId: `calendar:${month}:${sport}:${home}`,
    grounding: [`calendar:${now.toISOString().slice(0, 10)}:${sport}_regular_season`, `city_team:${home}:${team}`],
    place: home,
  };
}
