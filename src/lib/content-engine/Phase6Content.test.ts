import { describe, expect, it } from 'vitest';
import {
  buildClubDigestDraft,
  buildClubTournamentResultDraft,
  buildLocalEventDraft,
  buildSeasonalDraft,
  cleanSourceText,
  validLocalEvent,
} from './Phase6Content.js';

describe('Phase 6 content facts', () => {
  it('builds a club digest only from supplied daily and member aggregates', () => {
    const draft = buildClubDigestDraft(
      { id: 'page-1', owner_id: 'owner-1', name: 'River Club', linked_entity_id: 'club-1', is_public: true },
      [{ club_id: 'club-1', stat_date: '2026-09-06', hands: 120, pot_total: 4500 }],
      [{ club_id: 'club-1', stat_date: '2026-09-06', biggest_pot_won: 900 }],
      false,
    );
    expect(draft?.content).toBe('Club table report for Sep 6: River Club dealt 120 hands, 4,500 chips moved through the pots, the biggest recorded pot was 900 chips.');
    expect(draft?.grounding).toEqual(['club_hand_daily:club-1:2026-09-06']);
    expect(draft?.publicationKey).toContain('phase6:club:day:club-1:2026-09-06');
  });

  it('does not invent a digest for an empty, private, or unsupported club', () => {
    const page = { id: 'p', owner_id: 'o', name: 'Club', linked_entity_id: 'c', is_public: true };
    expect(buildClubDigestDraft(page, [], [], false)).toBeNull();
    expect(buildClubDigestDraft({ ...page, is_public: false }, [{ club_id: 'c', stat_date: '2026-09-06', hands: 5, pot_total: 10 }], [], false)).toBeNull();
  });

  it('adds only supplied jackpot and named leaderboard facts', () => {
    const draft = buildClubDigestDraft(
      { id: 'p', owner_id: 'o', name: 'River Club', linked_entity_id: 'c', is_public: true },
      [{ club_id: 'c', stat_date: '2026-09-06', hands: 10, pot_total: 100 }],
      [{ club_id: 'c', stat_date: '2026-09-06', user_id: 'u', biggest_pot_won: 50, profit: 75 }],
      false,
      { jackpot: { id: 'j', current_amount: 2500 }, leader: { user_id: 'u', display_name: 'River Ace', profit: 75 } },
    );
    expect(draft?.content).toContain('active bad beat jackpot stands at 2,500 chips');
    expect(draft?.content).toContain('River Ace leads the period at +75 chips');
    expect(draft?.grounding).toContain('bad_beat_jackpots:j');
  });

  it('builds a grounded club tournament result and omits absent facts', () => {
    const page = { id: 'p', owner_id: 'o', name: 'River Club', linked_entity_id: 'c', is_public: true };
    const tournament = { id: 't', club_id: 'c', name: 'Sunday Major', ended_at: '2026-09-06T20:00:00Z', prize_pool: 10000, current_players: 40 };
    const draft = buildClubTournamentResultDraft(page, tournament, { tournament_id: 't', user_id: 'u', username: 'Ace High', position: 1, prize: 4000 });
    expect(draft?.content).toBe('Sunday Major is complete at River Club, Ace High finished first, the first-place prize was 4,000 chips, 40 players entered, the prize pool was 10,000 chips.');
    expect(draft?.publicationKey).toBe('phase6:club:tournament:t');
    expect(buildClubTournamentResultDraft(page, { ...tournament, club_id: 'other' }, null)).toBeNull();
  });

  it('rejects malformed scraper labels and inactive or suppressed events', () => {
    expect(cleanSourceText('agency_aps_iFrame')).toBeNull();
    const event = { source: 'daily', native_id: 'e1', venue_name: 'Bell Room', event_name: 'Friday Deepstack', specific_date: '2026-09-10', start_time: '7:00PM', city: 'Las Vegas', state: 'NV', is_active: true, is_suppressed: false };
    expect(validLocalEvent(event, '2026-09-07', '2026-09-21')).toBe(true);
    expect(validLocalEvent({ ...event, is_active: false }, '2026-09-07', '2026-09-21')).toBe(false);
    expect(validLocalEvent({ ...event, is_suppressed: true }, '2026-09-07', '2026-09-21')).toBe(false);
  });

  it('matches local events by exact normalized city and state', () => {
    const events = [{ source: 'daily', native_id: 'e1', venue_name: 'Bell Room', event_name: 'Friday Deepstack', specific_date: '2026-09-10', start_time: '7:00PM', city: 'Las Vegas', state: 'NV', is_active: true, is_suppressed: false }];
    const draft = buildLocalEventDraft({ profile_id: 'h1', name: 'Horse', city: ' las vegas ', state: 'nv' }, events, '2026-09-07', '2026-09-21');
    expect(draft?.content).toContain('Friday Deepstack');
    expect(draft?.content).toContain('Bell Room');
    expect(draft?.publicationKey).toBe('phase6:local:daily:e1');
    expect(buildLocalEventDraft({ profile_id: 'h2', name: 'Horse', city: 'Reno', state: 'NV' }, events, '2026-09-07', '2026-09-21')).toBeNull();
  });

  it('does not repeat a start time already present in an event title', () => {
    const events = [{ source: 'daily', native_id: 'e2', venue_name: 'Bell Room', event_name: 'PLO 6:30PM', specific_date: '2026-09-10', start_time: '6:30 PM', city: 'Las Vegas', state: 'NV', is_active: true, is_suppressed: false }];
    const content = buildLocalEventDraft({ profile_id: 'h1', name: 'Horse', city: 'Las Vegas', state: 'NV' }, events, '2026-09-07', '2026-09-21')?.content ?? '';
    expect(content.match(/6:30\s*PM/gi)).toHaveLength(1);
  });

  it('uses 2026 season and a curated city-team fact without emoji or em dashes', () => {
    const draft = buildSeasonalDraft({ profile_id: 'h1', name: 'Horse', city: 'Las Vegas', state: 'NV' }, new Date('2026-09-07T12:00:00Z'));
    expect(draft?.content).toContain('Raiders');
    expect(draft?.publicationKey).toBe('phase6:season:2026-09:football:las vegas|nv');
    expect(draft?.content).not.toMatch(/[\u2014\u{1F000}-\u{1FAFF}]/u);
    expect(buildSeasonalDraft({ profile_id: 'h2', name: 'Horse', city: 'Reno', state: 'NV' }, new Date('2026-09-07T12:00:00Z'))).toBeNull();
  });
});
