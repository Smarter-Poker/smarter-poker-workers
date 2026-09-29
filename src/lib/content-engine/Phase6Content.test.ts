import { describe, expect, it } from 'vitest';
import {
  buildClubDigestDraft,
  buildLocalEventDraft,
  buildSeasonalDraft,
  cleanSourceText,
  isJunkSourceText,
  localEventFacts,
  parseEventTitle,
  spreadLocalDrafts,
  sportsInSeason,
  validLocalEvent,
  type LocalEventRow,
  type Phase6Draft,
} from './Phase6Content.js';

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

function listing(overrides: Partial<LocalEventRow> = {}): LocalEventRow {
  return {
    source: 'daily',
    native_id: 'e1',
    venue_name: 'Bell Room',
    event_name: 'Friday Deepstack',
    specific_date: '2026-09-10',
    start_time: '7:00PM',
    city: 'Las Vegas',
    state: 'NV',
    is_active: true,
    is_suppressed: false,
    ...overrides,
  };
}

// 2026-09-07T09:20Z is 02:20 in Las Vegas on Monday Sep 7.
const RUN = new Date('2026-09-07T09:20:00Z');

describe('Phase 6 content facts', () => {
  it('builds a daily club digest only from the day it reports on', () => {
    const draft = buildClubDigestDraft(
      { id: 'page-1', owner_id: 'owner-1', name: 'River Club', linked_entity_id: 'club-1', is_public: true },
      [
        { club_id: 'club-1', stat_date: '2026-09-05', hands: 999, pot_total: 99999 },
        { club_id: 'club-1', stat_date: '2026-09-06', hands: 120, pot_total: 4500 },
      ],
      { start: '2026-09-06', end: '2026-09-06', weekly: false },
      { biggestPot: 900 },
    );
    expect(draft?.content).toBe('River Club dealt 120 hands on Sep 6, and 4,500 chips went through the pots. Biggest pot of the day was 900 chips.');
    expect(draft?.grounding[0]).toBe('club_hand_daily:club-1:2026-09-06');
    expect(draft?.publicationKey).toBe('phase6:club:day:club-1:2026-09-06');
  });

  it('does not invent a digest for an empty, private, or unsupported club', () => {
    const page = { id: 'p', owner_id: 'o', name: 'Club', linked_entity_id: 'c', is_public: true };
    const day = { start: '2026-09-06', end: '2026-09-06', weekly: false };
    expect(buildClubDigestDraft(page, [], day)).toBeNull();
    expect(buildClubDigestDraft({ ...page, is_public: false }, [{ club_id: 'c', stat_date: '2026-09-06', hands: 5, pot_total: 10 }], day)).toBeNull();
    expect(buildClubDigestDraft(page, [{ club_id: 'c', stat_date: '2026-09-05', hands: 5, pot_total: 10 }], day)).toBeNull();
  });

  it('adds only supplied jackpot and leader facts, in a player voice', () => {
    const draft = buildClubDigestDraft(
      { id: 'p', owner_id: 'o', name: 'River Club', linked_entity_id: 'c', is_public: true },
      [{ club_id: 'c', stat_date: '2026-09-06', hands: 10, pot_total: 100 }],
      { start: '2026-09-06', end: '2026-09-06', weekly: false },
      { jackpot: { id: 'j', current_amount: 2500 }, leader: { user_id: 'u', display_name: 'River Ace', profit: 75.4 } },
    );
    expect(draft?.content).toContain("The bad beat jackpot's sitting at 2,500 chips.");
    expect(draft?.content).toContain('River Ace had the best day in the club at +75.');
    expect(draft?.grounding).toContain('bad_beat_jackpots:j');
  });

  it('keys a weekly digest by its exact period', () => {
    const stats = ['2026-09-14', '2026-09-15', '2026-09-20'].map((stat_date) => ({ club_id: 'c', stat_date, hands: 100, pot_total: 1000 }));
    const draft = buildClubDigestDraft(
      { id: 'p', owner_id: 'o', name: 'River Club', linked_entity_id: 'c', is_public: true },
      [...stats, { club_id: 'c', stat_date: '2026-09-13', hands: 5000, pot_total: 1 }],
      { start: '2026-09-14', end: '2026-09-20', weekly: true },
    );
    expect(draft?.content).toBe('River Club put up 300 hands between Sep 14 and Sep 20, and 3,000 chips went through the pots.');
    expect(draft?.publicationKey).toBe('phase6:club:week:c:2026-09-14:2026-09-20');
  });

  it('rejects malformed scraper labels and inactive or suppressed events', () => {
    expect(cleanSourceText('agency_aps_iFrame')).toBeNull();
    const event = listing();
    expect(validLocalEvent(event, '2026-09-07', '2026-09-21')).toBe(true);
    expect(validLocalEvent({ ...event, is_active: false }, '2026-09-07', '2026-09-21')).toBe(false);
    expect(validLocalEvent({ ...event, is_suppressed: true }, '2026-09-07', '2026-09-21')).toBe(false);
  });

  it('P6C-03: rejects the real scraped junk name and other class-like text before drafting', () => {
    const junk = listing({ native_id: 'd12ab3bb-c0f2-44b4-81dc-8a85741fd18d', event_name: 'slider-item slick-slide', venue_name: 'Casino Miami Jai-Alai Casino', city: 'Miami', state: 'FL' });
    expect(isJunkSourceText('slider-item slick-slide')).toBe(true);
    expect(isJunkSourceText('owl-item active')).toBe(true);
    expect(isJunkSourceText('<div class="event">Deepstack</div>')).toBe(true);
    expect(validLocalEvent(junk, '2026-09-07', '2026-09-21')).toBe(false);
    expect(buildLocalEventDraft({ profile_id: 'h1', name: 'Horse', city: 'Miami', state: 'FL' }, [junk], '2026-09-07', '2026-09-21', RUN)).toBeNull();
    for (const real of ["No Limit Hold'em 8:00PM $160 Buy In", 'T.O.E. (Limit 2-7 Triple Draw, Omaha 8, Stud 8)', 'NLH Turbo', 'Night Owl Deepstack', 'Omaha Hi-Lo Re-Entry']) {
      expect(isJunkSourceText(real)).toBe(false);
    }
  });

  it('matches local events by exact normalized city and state', () => {
    const events = [listing()];
    const draft = buildLocalEventDraft({ profile_id: 'h1', name: 'Horse', city: ' las vegas ', state: 'nv' }, events, '2026-09-07', '2026-09-21', RUN);
    expect(draft?.content).toContain('Friday Deepstack');
    expect(draft?.content).toContain('Bell Room');
    expect(draft?.publicationKey).toBe('phase6:local:daily:e1');
    expect(buildLocalEventDraft({ profile_id: 'h2', name: 'Horse', city: 'Reno', state: 'NV' }, events, '2026-09-07', '2026-09-21', RUN)).toBeNull();
  });

  it('P6C-08: parses a raw calendar title into game, buy-in and time', () => {
    expect(parseEventTitle("No Limit Hold'em 8:00PM $160 Buy In")).toEqual({ game: "No Limit Hold'em", buyIn: 160, titleMinutes: 20 * 60 });
    expect(parseEventTitle('$250 NLH Deepstack')).toEqual({ game: 'NLH Deepstack', buyIn: 250, titleMinutes: null });
    expect(parseEventTitle('Mega Satellite to $1,100')).toEqual({ game: 'Mega Satellite to $1,100', buyIn: null, titleMinutes: null });
    expect(parseEventTitle('6AM $10000 Buy In')).toBeNull();
    expect(parseEventTitle('PLO 6:30PM')).toEqual({ game: 'PLO', buyIn: null, titleMinutes: 18 * 60 + 30 });
    // Real production titles: a clock with no AM/PM, and a pre-dawn $10,000 row.
    expect(parseEventTitle("No Limit Hold'em 8:30 $40 Buy In")).toBeNull();
    expect(localEventFacts(listing({ event_name: "No Limit Hold'em 6AM $10000 Buy In", start_time: '6AM', specific_date: '2026-09-09' }), RUN)).toBeNull();
    expect(localEventFacts(listing({ event_name: "No Limit Hold'em 12AM $500 Buy In", start_time: '12AM', specific_date: '2026-09-09' }), RUN)).toBeNull();
  });

  it('P6C-08: says it like a player, with today, tonight or tomorrow for near dates and no raw title', () => {
    const raw = listing({ event_name: "No Limit Hold'em 8:00PM $160 Buy In", start_time: '8:00PM', specific_date: '2026-09-07' });
    const facts = localEventFacts(raw, RUN)!;
    expect(facts).toMatchObject({ game: "No Limit Hold'em", buyIn: 160, when: 'tonight at 8PM' });
    expect(localEventFacts({ ...raw, specific_date: '2026-09-08', start_time: '3:05PM', event_name: 'NLH Turbo' }, RUN)!.when).toBe('tomorrow at 3:05PM');
    expect(localEventFacts({ ...raw, specific_date: '2026-09-10' }, RUN)!.when).toBe('Thursday at 8PM');
    expect(localEventFacts({ ...raw, specific_date: '2026-09-18' }, RUN)!.when).toBe('on Sep 18 at 8PM');
    // A series row is its first day, not a single sitting.
    expect(localEventFacts({ ...raw, source: 'series', event_name: 'Super High Roller Bowl PLO IV', start_time: null, specific_date: '2026-09-18' }, RUN)!.when).toBe('starting Sep 18');
    // Already under way, or a start time that disagrees with the title: not announced.
    expect(localEventFacts({ ...raw, start_time: '3:00AM', event_name: 'NLH Turbo' }, RUN)).toBeNull();
    expect(localEventFacts({ ...raw, start_time: '9:00PM' }, RUN)).toBeNull();

    const texts: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const draft = buildLocalEventDraft({ profile_id: `h${i}`, name: 'Horse', city: 'Las Vegas', state: 'NV' }, [raw], '2026-09-07', '2026-09-21', RUN)!;
      texts.push(draft.content);
      expect(draft.content).toContain("No Limit Hold'em");
      expect(draft.content).toContain('tonight at 8PM');
      expect(draft.content).toContain('$160 buy-in');
      expect(draft.content).not.toMatch(/Buy In|8:00PM|on Sep 7|It is |That is /);
      expect(draft.content).not.toMatch(EMOJI);
      expect(draft.content.includes(EM_DASH) || draft.content.includes(EN_DASH)).toBe(false);
      // No number that is not in the source row.
      for (const number of draft.content.match(/\d[\d,:]*/g) ?? []) expect(['8', '160']).toContain(number.replace(/,/g, ''));
    }
    expect(new Set(texts).size).toBeGreaterThan(3);
    expect(texts.some((text) => /\b\w+'(?:s|re|d|ll|t)\b/.test(text) || /n't\b/.test(text))).toBe(true);
  });

  it('P6C-08: tidies a doubled venue type without changing the venue', () => {
    const facts = localEventFacts(listing({ venue_name: 'Casino Miami Jai-Alai Casino', city: 'Miami', state: 'FL', specific_date: '2026-09-09' }), RUN)!;
    expect(facts.venue).toBe('Casino Miami Jai-Alai');
  });

  it('P6C-08: picks a venue before a listing, and spreads the publish order across cities and venues', () => {
    const busy = Array.from({ length: 30 }, (_, i) => listing({ native_id: `hs${i}`, venue_name: 'Horseshoe Las Vegas', specific_date: '2026-09-09' }));
    const quiet = listing({ native_id: 'or1', venue_name: 'Orleans Casino', specific_date: '2026-09-09' });
    const venues = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      const draft = buildLocalEventDraft({ profile_id: `horse-${i}`, name: 'Horse', city: 'Las Vegas', state: 'NV' }, [...busy, quiet], '2026-09-07', '2026-09-21', RUN)!;
      venues.add(draft.venue!);
    }
    expect(venues.size).toBe(2);

    const make = (key: string, place: string, venue: string): Phase6Draft => ({ mode: 'local_event', authorId: key, content: key, publicationKey: key, sourceId: key, grounding: [], place, venue });
    const ordered = spreadLocalDrafts([
      make('v1', 'las vegas|nv', 'a'), make('v2', 'las vegas|nv', 'a'), make('v3', 'las vegas|nv', 'b'),
      make('m1', 'miami|fl', 'c'), make('n1', 'new orleans|la', 'd'),
    ]);
    expect(ordered.map((draft) => draft.publicationKey)).toEqual(['v1', 'm1', 'n1', 'v3', 'v2']);
  });

  it('P6C-13: only calls a sport in season when its regular season is on for that date', () => {
    expect(sportsInSeason(new Date('2026-09-21T12:00:00Z')).sort()).toEqual(['baseball', 'football']);
    expect(sportsInSeason(new Date('2026-07-15T12:00:00Z'))).toEqual(['baseball']);
    expect(sportsInSeason(new Date('2026-11-10T12:00:00Z')).sort()).toEqual(['basketball', 'football', 'hockey']);
    expect(sportsInSeason(new Date('2027-02-20T12:00:00Z')).sort()).toEqual(['basketball', 'hockey']);
    expect(sportsInSeason(new Date('2026-06-15T12:00:00Z'))).toEqual(['baseball']);
    // June: the Lakers may be out of the playoffs, so Los Angeles gets baseball.
    const june = buildSeasonalDraft({ profile_id: 'h1', name: 'Horse', city: 'Los Angeles', state: 'CA' }, new Date('2026-06-15T12:00:00Z'));
    expect(june?.content).toContain('Dodgers');
    expect(buildSeasonalDraft({ profile_id: 'h2', name: 'Horse', city: 'Las Vegas', state: 'NV' }, new Date('2026-07-15T12:00:00Z'))).toBeNull();
  });

  it('P6C-13: seasonal copy is a player talking, with no emoji, dashes or stiff phrasing', () => {
    const draft = buildSeasonalDraft({ profile_id: 'h1', name: 'Horse', city: 'Las Vegas', state: 'NV' }, new Date('2026-09-21T12:00:00Z'));
    expect(draft?.content).toContain('Raiders');
    expect(draft?.publicationKey).toBe('phase6:season:2026-09:football:las vegas|nv');
    for (const city of ['Las Vegas|NV', 'Chicago|IL', 'Boston|MA', 'Denver|CO', 'Phoenix|AZ', 'Seattle|WA', 'Tampa|FL', 'Detroit|MI']) {
      const [name, state] = city.split('|');
      for (const at of ['2026-09-21', '2026-11-10', '2027-01-15', '2026-05-10']) {
        const text = buildSeasonalDraft({ profile_id: 'h', name: 'Horse', city: name!, state: state! }, new Date(`${at}T12:00:00Z`))?.content;
        if (!text) continue;
        expect(text).toMatch(/'(?:s|ll|m|t)\b/);
        expect(text).not.toMatch(/\bI am\b|\bIt is\b|\bI will\b/);
        expect(text).not.toMatch(EMOJI);
        expect(text.includes(EM_DASH) || text.includes(EN_DASH)).toBe(false);
      }
    }
    expect(buildSeasonalDraft({ profile_id: 'h2', name: 'Horse', city: 'Reno', state: 'NV' }, new Date('2026-09-07T12:00:00Z'))).toBeNull();
  });
});
