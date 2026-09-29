/**
 * Behavioural Phase 6 tests through the real route handler, with a faked
 * PostgREST client that clamps every response at 1,000 rows and enforces the
 * production CHECK on social_posts.publication_key plus the unique
 * metadata->>publication_key indexes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb, type Row } from './phase6-content.fakedb.test-support.js';

const h = vi.hoisted(() => ({
  db: null as unknown,
  engineEnabled: vi.fn(),
  postModeEnabled: vi.fn(),
  loadFleet: vi.fn(),
  postedRecently: vi.fn(),
  recordPhrase: vi.fn(),
}));

vi.mock('../lib/supabase.js', () => ({ getSupabase: () => h.db }));
vi.mock('../lib/content-engine/Fleet.js', () => ({
  engineEnabled: h.engineEnabled,
  postModeEnabled: h.postModeEnabled,
  loadFleet: h.loadFleet,
}));
vi.mock('../lib/content-engine/HorsePublisher.js', () => ({ postedRecently: h.postedRecently }));
vi.mock('../lib/content-engine/ContentLedger.js', () => ({
  normalizePhrase: (value: string) => value,
  recordPhrase: h.recordPhrase,
}));

import { phase6Content } from './phase6-content.js';

interface DraftBody {
  authorId: string;
  content: string;
  publicationKey: string;
  author_is_horse: boolean;
  grounding: string[];
}
interface ModeResultBody {
  posted: number;
  skipped: Record<string, number>;
  errors: string[];
  rollback_failed_page_posts: string[];
  held: Array<{ reason: string; page_id?: string }>;
}
interface LiveBody {
  success: boolean;
  posted: number;
  results: Record<string, ModeResultBody>;
}
interface PreviewBody {
  success: boolean;
  content_writes: number;
  writes_note: string;
  samples: Record<string, DraftBody[]>;
  held: Record<string, Array<{ reason: string; draft: DraftBody | null }>>;
  skipped: Record<string, Record<string, number>>;
  notes: Record<string, string[]>;
}

const TUESDAY = new Date('2026-09-22T09:20:00Z');
const MONDAY = new Date('2026-09-21T09:20:00Z');
const CLUB = 'club-1';
const PAGE = 'page-1';
const OWNER_HORSE = 'horse-owner';
const HUMAN = 'human-1';

function context(query: Record<string, string> = {}) {
  let captured = { body: null as unknown, status: 0 };
  const c = {
    req: { query: (key: string) => query[key] },
    json: (body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return captured;
    },
    get captured() { return captured; },
  };
  return c as unknown as Parameters<typeof phase6Content>[0] & { readonly captured: { body: unknown; status: number } };
}

async function run(query: Record<string, string> = {}) {
  const c = context(query);
  await phase6Content(c);
  return c.captured;
}

async function live(): Promise<LiveBody> {
  return (await run()).body as LiveBody;
}

async function preview(at: Date): Promise<PreviewBody> {
  return (await run({ preview: '1', at: at.toISOString() })).body as PreviewBody;
}

function roster(extra: Array<{ id: string; city: string; state: string; is_horse: boolean; display_name: string }> = []) {
  const people = [
    { id: 'horse-a', city: 'Las Vegas', state: 'NV', is_horse: true, display_name: 'RiverRat' },
    { id: 'horse-b', city: 'Las Vegas', state: 'NV', is_horse: true, display_name: 'FlopMonk' },
    { id: OWNER_HORSE, city: 'Reno', state: 'NV', is_horse: true, display_name: 'ClubHorse' },
    ...extra,
  ];
  h.loadFleet.mockResolvedValue(people.map((person, index) => ({ id: index + 1, name: person.display_name, profile_id: person.id })));
  return people;
}

function event(nativeId: string, overrides: Partial<Row> = {}): Row {
  return {
    source: 'daily',
    native_id: nativeId,
    venue_name: 'Bell Room',
    event_name: "No Limit Hold'em 7:00PM $160 Buy In",
    specific_date: '2026-09-23',
    start_time: '7:00PM',
    city: 'Las Vegas',
    state: 'NV',
    is_active: true,
    is_suppressed: false,
    ...overrides,
  };
}

function world(options: { owner?: string; statDays?: string[]; events?: Row[]; members?: Row[]; extraPeople?: Parameters<typeof roster>[0] } = {}): FakeDb {
  const people = roster(options.extraPeople);
  const db = new FakeDb(1000);
  db.seed('profiles', [...people, { id: HUMAN, city: 'Reno', state: 'NV', is_horse: false, display_name: 'Real Person' }]);
  db.seed('social_pages', [{
    id: PAGE,
    owner_id: options.owner ?? OWNER_HORSE,
    name: 'Deep Stack Society',
    linked_entity_id: CLUB,
    linked_entity_type: 'club',
    is_public: true,
  }]);
  db.seed('club_hand_daily', (options.statDays ?? ['2026-09-19', '2026-09-20', '2026-09-21']).map((day) => ({
    club_id: CLUB, stat_date: day, hands: 1000, pot_total: 50000,
  })));
  db.seed('club_member_daily_stats', options.members ?? [
    { club_id: CLUB, table_id: 't1', user_id: 'horse-b', stat_date: '2026-09-21', profit: 300, biggest_pot_won: 4000 },
    { club_id: CLUB, table_id: 't1', user_id: 'horse-a', stat_date: '2026-09-21', profit: -300, biggest_pot_won: 1000 },
  ]);
  db.seed('unified_events_calendar', options.events ?? [event('e1')]);
  h.db = db;
  return db;
}

function enableOnly(...modes: string[]) {
  h.postModeEnabled.mockImplementation(async (mode: string) => modes.includes(mode));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: TUESDAY, toFake: ['Date'] });
  h.engineEnabled.mockResolvedValue(true);
  h.postedRecently.mockResolvedValue(false);
  h.recordPhrase.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('L-01: Phase 6 idempotency lives in metadata.publication_key', () => {
  it('writes no publication_key column on any insert, and every row carries a namespaced metadata key', async () => {
    const db = world();
    enableOnly('club_data_digest', 'local_event', 'seasonal_local');
    const body = await live();
    expect(body.results.club_data_digest!.posted).toBe(1);
    expect(body.results.local_event!.posted).toBe(1);
    expect(body.results.seasonal_local!.posted).toBe(1);
    const inserted = [...db.inserts('social_posts'), ...db.inserts('social_page_posts')];
    expect(inserted).toHaveLength(4);
    for (const row of inserted) {
      expect(Object.prototype.hasOwnProperty.call(row, 'publication_key')).toBe(false);
      expect(String((row.metadata as Row).publication_key)).toMatch(/^phase6:/);
    }
  });

  it('counts a 23505 unique violation on insert as a duplicate, not a failure', async () => {
    const db = world();
    enableOnly('local_event');
    db.fail('social_posts', 'insert', {
      code: '23505',
      message: 'duplicate key value violates unique constraint "uq_social_posts_metadata_publication_key"',
    }, 1);
    const result = (await live()).results.local_event!;
    expect(result.skipped.duplicate).toBe(1);
    expect(result.skipped.failed).toBe(0);
    expect(result.posted).toBe(0);
  });

  it('lets exactly one of two overlapping runs publish a key; the other sees a duplicate', async () => {
    const db = world();
    enableOnly('local_event');
    const [first, second] = await Promise.all([run(), run()]);
    const results = [first, second].map((captured) => (captured.body as LiveBody).results.local_event!);
    expect(results.reduce((sum, result) => sum + result.posted, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.skipped.duplicate, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.skipped.failed, 0)).toBe(0);
    expect(db.rows('social_posts')).toHaveLength(1);
  });

  it('treats a page post that already carries the key as published', async () => {
    const db = world();
    enableOnly('club_data_digest');
    db.seed('social_page_posts', [{ id: 'orphan', page_id: PAGE, metadata: { publication_key: `phase6:club:day:${CLUB}:2026-09-21` } }]);
    const result = (await live()).results.club_data_digest!;
    expect(result.skipped.duplicate).toBe(1);
    expect(db.writes()).toHaveLength(0);
  });
});

describe('P6C-01: club digests never post under a non-horse profile', () => {
  it('holds a digest whose page owner is not a roster horse and writes nothing', async () => {
    const db = world({ owner: HUMAN });
    enableOnly('club_data_digest');
    const result = (await live()).results.club_data_digest!;
    expect(result.posted).toBe(0);
    expect(result.skipped.club_author_not_horse).toBe(1);
    expect(result.held).toEqual([expect.objectContaining({ reason: 'club_author_not_horse', page_id: PAGE })]);
    expect(db.writes()).toHaveLength(0);
    // Held before the heavy member-stat read.
    expect(db.calls.some((call) => call.table === 'club_member_daily_stats')).toBe(false);
  });

  it('shows a held digest in preview, marked as not a horse author', async () => {
    world({ owner: HUMAN });
    const body = await preview(TUESDAY);
    expect(body.samples.club_data_digest).toHaveLength(0);
    expect(body.held.club_data_digest![0]!.reason).toBe('club_author_not_horse');
    expect(body.held.club_data_digest![0]!.draft!.author_is_horse).toBe(false);
  });
});

describe('P6C-02/07/09: exact leader and biggest pot for the exact period', () => {
  function weeklyMembers(topHuman = false): Row[] {
    const rows: Row[] = [];
    // RiverRat: 1,000 winning rows first (+20,000) but 150 losing rows (-15,000): net +5,000.
    for (let i = 0; i < 1000; i += 1) rows.push({ club_id: CLUB, table_id: `ta${i}`, user_id: 'horse-a', stat_date: '2026-09-14', profit: 20, biggest_pot_won: 500 });
    for (let i = 0; i < 150; i += 1) rows.push({ club_id: CLUB, table_id: `tl${i}`, user_id: 'horse-a', stat_date: '2026-09-18', profit: -100, biggest_pot_won: 100 });
    // FlopMonk: 1,200 rows of +10: net +12,000, the true leader.
    for (let i = 0; i < 1200; i += 1) rows.push({ club_id: CLUB, table_id: `tb${i}`, user_id: 'horse-b', stat_date: '2026-09-16', profit: 10, biggest_pot_won: i === 7 ? 86993 : 200 });
    // Bigger pots before the period must not count.
    for (let i = 0; i < 150; i += 1) rows.push({ club_id: CLUB, table_id: `tp${i}`, user_id: 'horse-a', stat_date: '2026-09-10', profit: 0, biggest_pot_won: 500000 + i });
    if (topHuman) rows.push({ club_id: CLUB, table_id: 'th', user_id: HUMAN, stat_date: '2026-09-19', profit: 50000, biggest_pot_won: 10 });
    return rows;
  }
  const weekDays = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'];

  it('names the true net leader over the whole period, past the 1,000-row cap', async () => {
    world({ members: weeklyMembers(), statDays: weekDays });
    const body = await preview(MONDAY);
    const digest = body.samples.club_data_digest![0]!;
    expect(digest.content).toContain('FlopMonk finished the week on top of the club at +12,000.');
    expect(digest.content).not.toContain('RiverRat');
    expect(digest.content).toContain('Biggest pot of the week was 86,993 chips.');
    expect(digest.content).toContain('between Sep 14 and Sep 20');
    expect(digest.publicationKey).toBe(`phase6:club:week:${CLUB}:2026-09-14:2026-09-20`);
  });

  it('never names a human leader, and names nobody in their place', async () => {
    world({ members: weeklyMembers(true), statDays: weekDays });
    const body = await preview(MONDAY);
    const digest = body.samples.club_data_digest![0]!;
    expect(digest.content).not.toMatch(/on top of the club|Real Person|FlopMonk|RiverRat/);
    expect(body.notes.club_data_digest!.join(' ')).toContain('not a roster horse');
  });

  it('drops the leader and biggest pot when the exact count cannot be confirmed', async () => {
    const db = world({ members: weeklyMembers(), statDays: weekDays });
    db.fail('club_member_daily_stats', 'count', { message: 'count unavailable' });
    const body = await preview(MONDAY);
    const digest = body.samples.club_data_digest![0]!;
    expect(digest.content).not.toMatch(/on top of the club|Biggest pot/);
    expect(digest.content).toContain('7,000 hands');
  });
});

describe('P6C-14: a daily report only for actual yesterday', () => {
  it('skips a club whose latest stat day is not yesterday as stale_day', async () => {
    const db = world({ statDays: ['2026-09-19', '2026-09-20'] });
    enableOnly('club_data_digest');
    const result = (await live()).results.club_data_digest!;
    expect(result.skipped.stale_day).toBe(1);
    expect(result.posted).toBe(0);
    expect(db.writes()).toHaveLength(0);
  });

  it('refuses a live run pointed at another day with ?at=', async () => {
    const db = world({ statDays: ['2026-09-08', '2026-09-09'] });
    enableOnly('club_data_digest');
    const result = ((await run({ at: '2026-09-10T09:20:00Z' })).body as LiveBody).results.club_data_digest!;
    expect(result.skipped.stale_day).toBe(1);
    expect(db.writes()).toHaveLength(0);
  });
});

describe('P6C-05: a failed rollback is reported and caught next run', () => {
  it('reports rollback_failed with the page post id and never claims a rollback', async () => {
    const db = world();
    enableOnly('club_data_digest');
    db.fail('social_posts', 'insert', { message: 'mirror down' }, 1);
    db.fail('social_page_posts', 'delete', { message: 'delete refused' }, 1);
    const first = (await live()).results.club_data_digest!;
    const orphan = db.rows('social_page_posts')[0]!;
    expect(first.skipped.rollback_failed).toBe(1);
    expect(first.rollback_failed_page_posts).toEqual([orphan.id]);
    expect(first.errors.join(' ')).toContain(`rollback of page post ${String(orphan.id)} failed`);
    expect(first.errors.join(' ')).not.toContain('rolled back');

    const second = (await live()).results.club_data_digest!;
    expect(second.skipped.duplicate).toBe(1);
    expect(second.posted).toBe(0);
    expect(db.rows('social_page_posts')).toHaveLength(1);
  });

  it('says rolled back only after the delete removed the page post', async () => {
    const db = world();
    enableOnly('club_data_digest');
    db.fail('social_posts', 'insert', { message: 'mirror down' }, 1);
    const result = (await live()).results.club_data_digest!;
    expect(result.skipped.failed).toBe(1);
    expect(result.errors.join(' ')).toContain('rolled back');
    expect(db.rows('social_page_posts')).toHaveLength(0);
  });
});

describe('P6C-06/03: the whole event window, without junk', () => {
  it('finds a horse-city listing beyond the first 1,000 rows of the window', async () => {
    const filler = Array.from({ length: 2500 }, (_, i) => event(`f${String(i).padStart(4, '0')}`, {
      city: 'Elsewhere', state: 'ZZ', specific_date: i < 1250 ? '2026-09-22' : '2026-09-24',
    }));
    const db = world({ events: [...filler, event('vegas-late', { specific_date: '2026-10-01' })] });
    enableOnly('local_event');
    const result = (await live()).results.local_event!;
    expect(result.posted).toBe(1);
    expect((db.inserts('social_posts')[0]!.metadata as Row).publication_key).toBe('phase6:local:daily:vegas-late');
  });

  it('rejects scraped class names before drafting and counts them as junk', async () => {
    const db = world({ events: [event('junk', { event_name: 'slider-item slick-slide', venue_name: 'Casino Miami Jai-Alai Casino' })] });
    enableOnly('local_event');
    const result = (await live()).results.local_event!;
    expect(result.skipped.junk).toBe(1);
    expect(result.posted).toBe(0);
    expect(db.writes()).toHaveLength(0);
  });
});

describe('P6C-10: the 20-hour guard fails closed', () => {
  it('counts an unreadable guard as recent and does not post', async () => {
    const db = world();
    enableOnly('local_event');
    h.postedRecently.mockRejectedValue(new Error('recent-post guard read failed'));
    const result = (await live()).results.local_event!;
    expect(result.skipped.recent).toBe(1);
    expect(result.skipped.failed).toBe(0);
    expect(db.writes()).toHaveLength(0);
  });

  it('counts the guard fail-closed answer (true on a read error) as recent', async () => {
    const db = world();
    enableOnly('seasonal_local');
    h.postedRecently.mockResolvedValue(true);
    const result = (await live()).results.seasonal_local!;
    expect(result.skipped.recent).toBe(1);
    expect(db.writes()).toHaveLength(0);
  });
});

describe('P6C-11/12 and telemetry', () => {
  it('preview says precisely that it makes no content writes, and makes none', async () => {
    const db = world();
    const body = await preview(TUESDAY);
    expect(body.content_writes).toBe(0);
    expect(body.writes_note).toContain('no content writes');
    expect(body.writes_note).toContain('cron_execution_log');
    expect(body).not.toHaveProperty('writes');
    expect(db.writes()).toHaveLength(0);
    expect(body.samples.local_event!.every((draft) => draft.author_is_horse)).toBe(true);
  });

  it('never reads the removed completed-tournament path', async () => {
    const db = world();
    await preview(TUESDAY);
    expect(db.calls.some((call) => call.table === 'tournaments' || call.table === 'tournament_players')).toBe(false);
  });

  it('reports skip counts by reason for every mode on a live run', async () => {
    world({ extraPeople: [{ id: 'not-a-horse', city: 'Las Vegas', state: 'NV', is_horse: false, display_name: 'Profile' }] });
    enableOnly('club_data_digest', 'local_event', 'seasonal_local');
    const body = await live();
    for (const mode of ['club_data_digest', 'local_event', 'seasonal_local']) {
      expect(Object.keys(body.results[mode]!.skipped).sort()).toEqual([
        'author_not_horse', 'club_author_not_horse', 'duplicate', 'failed', 'junk', 'recent', 'rollback_failed', 'stale_day',
      ]);
    }
    expect(body.results.local_event!.skipped.author_not_horse).toBe(1);
    const authors = [...(h.db as FakeDb).inserts('social_posts')].map((row) => row.author_id);
    expect(authors).not.toContain('not-a-horse');
  });
});
