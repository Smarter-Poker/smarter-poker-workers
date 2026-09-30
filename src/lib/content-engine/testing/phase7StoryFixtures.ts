/**
 * Fixture rows for the Phase 7 story modes. TEST-ONLY: nothing the service
 * runs imports it.
 *
 * The rows follow the production shapes checked on 2026-09-29 (SELECT only):
 * `horse_hand_reviews` with word suits and a per-action table snapshot,
 * `tournaments` with `current_level` and `blind_level_state`,
 * `tournament_players` with live `chips` on `status = 'playing'` rows and a
 * `username`, and `profiles.settings` as jsonb. One seat in every tournament
 * and one opponent in every hand is a person, with an id and a name that no
 * draft may ever contain.
 */
import type { FleetHorse } from '../HorsePublisher.js';
import type { FakeDb, Row } from './fakeSupabase.js';

export const NOW = new Date('2026-09-29T18:30:00.000Z');
export const DAY = '2026-09-29';
export const HOUR_BUCKET = '2026-09-29T18';

export const HORSE_A = 'a0000000-0000-4000-8000-00000000000a';
export const HORSE_B = 'b0000000-0000-4000-8000-00000000000b';
export const HORSE_C = 'c0000000-0000-4000-8000-00000000000c';
/** A person. Never in a draft. */
export const HUMAN_ID = '11111111-2222-4333-8444-555555555555';
export const HUMAN_NAME = 'Real Person';
/** A second person who did not opt in. */
export const HUMAN2_ID = '22222222-3333-4444-8555-666666666666';

export const FLEET: FleetHorse[] = [
  { id: 1, name: 'Horse One', profile_id: HORSE_A },
  { id: 2, name: 'Horse Two', profile_id: HORSE_B },
  { id: 3, name: 'Horse Three', profile_id: HORSE_C },
];

export const T1 = 't1000000-0000-4000-8000-000000000001';
export const T2 = 't2000000-0000-4000-8000-000000000002';
export const T3 = 't3000000-0000-4000-8000-000000000003';
export const T4 = 't4000000-0000-4000-8000-000000000004';
/** A running MTT with nobody from the fleet in it. */
export const T5 = 't5000000-0000-4000-8000-000000000005';

const BULLET = String.fromCharCode(0x2022);
export const T1_NAME = `DSS Friday $100 Turbo Freeroll ${BULLET} 1 PM CT`;
export const T1_SYSTEM_NAME = 'DSS Friday $100 Turbo Freeroll';
export const T2_NAME = "Dan's Tuesday Game";

function card(rank: string, suit: string): Row {
  return { rank, suit };
}

const RIVER_BOARD = [card('2', 'clubs'), card('7', 'clubs'), card('A', 'clubs'), card('Q', 'clubs'), card('2', 'diamonds')];

type Act = { stage: string; action: string; userId: string; amount?: number; currentBet?: number; seat?: number; stack?: number };
function log(entries: Act[]): Row[] {
  return entries.map((e) => ({
    seat: e.seat ?? (e.userId === HUMAN_ID ? 2 : 1),
    stage: e.stage,
    action: e.action,
    amount: e.amount ?? 0,
    origin: e.action === 'sb' || e.action === 'bb' ? 'forced' : 'horse_policy',
    userId: e.userId,
    timestamp: '2026-08-30T12:00:00.000Z',
    publicNode: { pot: 0, currentBet: e.currentBet ?? 0, seats: [[1, e.stack ?? 200], [2, 200]] },
  }));
}

/** Horse A shoves the turn, gets called, wins at showdown. */
export const SHOVE_TURN_WIN = log([
  { stage: 'preflop', action: 'sb', userId: HUMAN_ID, amount: 1 },
  { stage: 'preflop', action: 'bb', userId: HORSE_A, amount: 2 },
  { stage: 'preflop', action: 'raise', userId: HUMAN_ID, amount: 6, currentBet: 2 },
  { stage: 'preflop', action: 'call', userId: HORSE_A, amount: 4, currentBet: 6 },
  { stage: 'flop', action: 'check', userId: HORSE_A },
  { stage: 'flop', action: 'bet', userId: HUMAN_ID, amount: 8 },
  { stage: 'flop', action: 'call', userId: HORSE_A, amount: 8, currentBet: 8 },
  { stage: 'turn', action: 'all_in', userId: HORSE_A, amount: 100, currentBet: 0, stack: 100 },
  { stage: 'turn', action: 'call', userId: HUMAN_ID, amount: 100, currentBet: 100 },
]);

/** Horse B folds the turn to a bet. */
export const FOLD_TURN = log([
  { stage: 'preflop', action: 'sb', userId: HORSE_B, amount: 1 },
  { stage: 'preflop', action: 'bb', userId: HUMAN_ID, amount: 2 },
  { stage: 'preflop', action: 'raise', userId: HORSE_B, amount: 6, currentBet: 2 },
  { stage: 'preflop', action: 'call', userId: HUMAN_ID, amount: 4, currentBet: 6 },
  { stage: 'flop', action: 'bet', userId: HORSE_B, amount: 8 },
  { stage: 'flop', action: 'call', userId: HUMAN_ID, amount: 8, currentBet: 8 },
  { stage: 'turn', action: 'check', userId: HORSE_B },
  { stage: 'turn', action: 'bet', userId: HUMAN_ID, amount: 30 },
  { stage: 'turn', action: 'fold', userId: HORSE_B, currentBet: 30 },
]);

export function seedThrowbackRows(db: FakeDb): void {
  db.seed('horse_hand_reviews', [
    {
      id: 101, hand_id: 'hand-0101', horse_user_id: HORSE_A, played_at: '2026-08-30T12:00:00.000Z',
      game_variant: 'nlh', format: 'cash', big_blind: 2, net_bb: 62, is_win: true, pot_size: 250,
      hole_cards: [card('K', 'clubs'), card('7', 'diamonds')], board: RIVER_BOARD, actions: SHOVE_TURN_WIN,
    },
    // Too recent for a throwback (5 days).
    {
      id: 102, hand_id: 'hand-0102', horse_user_id: HORSE_A, played_at: '2026-09-24T12:00:00.000Z',
      game_variant: 'nlh', format: 'cash', big_blind: 2, net_bb: 80, is_win: true, pot_size: 320,
      hole_cards: [card('A', 'spades'), card('A', 'hearts')], board: RIVER_BOARD, actions: SHOVE_TURN_WIN,
    },
    // Old enough but not worth telling (10bb).
    {
      id: 103, hand_id: 'hand-0103', horse_user_id: HORSE_A, played_at: '2026-08-20T12:00:00.000Z',
      game_variant: 'nlh', format: 'cash', big_blind: 2, net_bb: -10, is_win: false, pot_size: 40,
      hole_cards: [card('9', 'spades'), card('8', 'hearts')], board: RIVER_BOARD, actions: FOLD_TURN,
    },
    // Horse B, 22 days ago, a fold on the turn for a fractional loss.
    {
      id: 104, hand_id: 'hand-0104', horse_user_id: HORSE_B, played_at: '2026-09-07T12:00:00.000Z',
      game_variant: 'nlh', format: 'tournament', big_blind: 400, net_bb: -40.5, is_win: false, pot_size: 32400,
      hole_cards: [card('J', 'hearts'), card('J', 'spades')], board: RIVER_BOARD, actions: FOLD_TURN,
    },
  ]);
}

export function seedTournamentRows(db: FakeDb): void {
  db.seed('tournaments', [
    {
      id: T1, name: T1_NAME, tournament_type: 'MTT', status: 'RUNNING', current_level: 6,
      blind_level_state: { ante: 80, index: 6, big_blind: 600, small_blind: 300 }, starting_chips: 10000,
      started_at: '2026-09-29T16:00:00.000Z', on_break: false,
    },
    {
      id: T2, name: T2_NAME, tournament_type: 'SATELLITE', status: 'RUNNING', current_level: null,
      blind_level_state: null, starting_chips: null, started_at: '2026-09-29T17:00:00.000Z', on_break: false,
    },
    { id: T3, name: 'Sunday Deep Stack', tournament_type: 'MTT', status: 'COMPLETED', current_level: 12, started_at: '2026-09-28T16:00:00.000Z' },
    { id: T4, name: 'Turbo SNG', tournament_type: 'SNG', status: 'RUNNING', current_level: 3, started_at: '2026-09-29T18:00:00.000Z' },
    { id: T5, name: 'Monday Night Turbo', tournament_type: 'MTT', status: 'RUNNING', current_level: 2, started_at: '2026-09-29T18:10:00.000Z' },
  ]);
  db.seed('tournament_players', [
    { id: 'tp-0001', tournament_id: T1, user_id: HORSE_A, username: 'horse_one', status: 'playing', chips: 10908, chip_count: 0 },
    { id: 'tp-0002', tournament_id: T1, user_id: HUMAN_ID, username: HUMAN_NAME, status: 'playing', chips: 5000, chip_count: 0 },
    // A person who did not opt in, with a chip count no draft may carry.
    { id: 'tp-0002b', tournament_id: T1, user_id: HUMAN2_ID, username: 'quiet_person', status: 'playing', chips: 7777, chip_count: 0 },
    { id: 'tp-0003', tournament_id: T1, user_id: HORSE_B, username: 'horse_two', status: 'eliminated', chips: 0, chip_count: 0 },
    { id: 'tp-0004', tournament_id: T2, user_id: HORSE_B, username: 'horse_two', status: 'playing', chips: 4000, chip_count: 0 },
    { id: 'tp-0005', tournament_id: T2, user_id: HUMAN_ID, username: HUMAN_NAME, status: 'playing', chips: 6000, chip_count: 0 },
    { id: 'tp-0006', tournament_id: T3, user_id: HORSE_C, username: 'horse_three', status: 'winner', chips: 0, chip_count: 0 },
    { id: 'tp-0007', tournament_id: T4, user_id: HORSE_C, username: 'horse_three', status: 'playing', chips: 1500, chip_count: 0 },
    { id: 'tp-0008', tournament_id: T5, user_id: HUMAN_ID, username: HUMAN_NAME, status: 'playing', chips: 9100, chip_count: 0 },
  ]);
}

export function seedProfiles(db: FakeDb, optIn: boolean): void {
  db.seed('profiles', [
    { id: HORSE_A, is_horse: true, settings: { rail_opt_in: 'true' } },
    { id: HUMAN_ID, is_horse: false, settings: optIn ? { rail_opt_in: 'true' } : { theme: 'dark' } },
    { id: HUMAN2_ID, is_horse: null, settings: { rail_opt_in: 'false' } },
  ]);
}
