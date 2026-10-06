/**
 * Behavioural Phase 10 digest tests through the real route handler and the
 * real run. The RPC is a hand mock (horses-stories.test.ts), the mode rows
 * come from the fleet's in-memory PostgREST stand-in, the master switch is
 * mocked at its Fleet.js contract, and the Resend call is a stubbed global
 * fetch (tournamentReminderWorker.test.ts). The fixture payload is the
 * rpc-contract.md shape with distinct non-zero figures, so "every figure is
 * in the mail" means something. The last block reads the sources and pins
 * the wiring and the laws the behavioural tests cannot see.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeDb } from '../lib/content-engine/testing/fakeSupabase.js';

const h = vi.hoisted(() => ({
  db: null as unknown as { client: { from: (table: string) => unknown } },
  rpc: vi.fn(),
  engineSwitch: vi.fn(),
}));

vi.mock('../lib/supabase.js', () => ({
  getSupabase: () => ({ rpc: h.rpc, from: (table: string) => h.db.client.from(table) }),
}));
vi.mock('../lib/content-engine/Fleet.js', () => ({
  engineSwitch: h.engineSwitch,
}));

import { fleetWeeklyDigest } from './fleet-weekly-digest.js';
import {
  CAPTION_DASHES,
  CAPTION_EMOJI,
  DEADLINE_MS,
  DEFAULT_FROM_EMAIL,
  DRY_RUN_WRITES_NOTE,
  METRICS_FUNCTION,
  parseMetrics,
  parseRecipients,
  renderDigest,
  RESEND_TIMEOUT_MS,
  RESEND_URL,
  runDigest,
  WINDOW_DAYS,
  type DigestResult,
} from './fleet-weekly-digest.js';

/** The Monday fire, seven seconds after the dispatcher's 09:30 UTC. */
const NOW = new Date('2026-10-06T09:30:07Z');
const KEY = 're_test_key_123456';
const RECIPIENTS = 'owner@example.test, second@example.test';
const ADDRESSES = ['owner@example.test', 'second@example.test'];

type RunFixture = Record<string, number | string>;

function run(jobName: string, counts: Record<string, number>): RunFixture {
  return {
    job_name: jobName,
    runs: 0, succeeded: 0, errored: 0, killed: 0, skipped_runs: 0, engine_off_runs: 0,
    due: 0, posted: 0, failed: 0, collided: 0, enqueued: 0,
    ...counts,
  };
}

/** rpc-contract.md, with distinct figures. Columns a route never writes stay 0, as the RPC's sums leave them. */
function fixture() {
  return {
    window: { days: 7, since: '2026-09-29T09:30:00+00:00', until: '2026-10-06T09:30:00+00:00' },
    feed: { horse_posts: 1234, feed_posts: 1456, horse_share_pct: 84.8 },
    reactions: { human_likes: 321, human_comments: 57, horse_posts: 1234, per_horse_post: 0.306 },
    captions: { horse_posts: 1230, distinct_captions: 1207, distinct_caption_pct: 98.1 },
    coverage: { horses_posted: 612, fleet_size: 938, coverage_pct: 65.2, coverage_pct_of_1000: 61.2 },
    readiness: { horses_not_social_ready: 62 },
    posts: { horse_posts: 1240, horses_posted: 615 },
    runs: [
      run('/cron/horse-posts', { runs: 168, succeeded: 160, errored: 5, killed: 3, skipped_runs: 21, engine_off_runs: 20, due: 1300, posted: 1180, failed: 40, collided: 6 }),
      run('/cron/horse-video-reels', { runs: 167, succeeded: 165, errored: 2, killed: 0, skipped_runs: 22, engine_off_runs: 19, due: 410, posted: 96, failed: 9 }),
      run('/cron/horses-social-all', { runs: 166, succeeded: 164, errored: 1, killed: 1, skipped_runs: 23, engine_off_runs: 23 }),
      run('/cron/horses-social-friends', { runs: 24, succeeded: 24, errored: 0, killed: 0, skipped_runs: 3, engine_off_runs: 3 }),
      run('/cron/horses-stories', { runs: 165, succeeded: 163, errored: 2, killed: 0, skipped_runs: 24, engine_off_runs: 18, posted: 88 }),
      run('/cron/phase6-content', { runs: 164, succeeded: 162, errored: 2, killed: 0, skipped_runs: 25, engine_off_runs: 17, posted: 73 }),
      run('/cron/phase7-content', { runs: 163, succeeded: 161, errored: 2, killed: 0, skipped_runs: 26, engine_off_runs: 16 }),
      run('/cron/phase9-content', { runs: 162, succeeded: 159, errored: 2, killed: 1, skipped_runs: 27, engine_off_runs: 15, enqueued: 7 }),
    ],
    ledger: {
      phrases: [
        { kind: 'caption', rows_written: 1180, distinct_keys: 1150, rows_that_repeat: 44 },
        { kind: 'meaning', rows_written: 1100, distinct_keys: 980, rows_that_repeat: 210 },
        { kind: 'frame', rows_written: 1210, distinct_keys: 310, rows_that_repeat: 1030 },
      ],
      assets: { rows: 877, distinct: 851 },
    },
  };
}

function seedModes(): void {
  db.seed('horse_post_modes', [
    { mode: 'poker_news', enabled: true, approved_at: '2026-09-29T22:44:13+00:00', description: 'news' },
    { mode: 'hand_clip', enabled: false, approved_at: null, description: 'clips' },
    { mode: 'grounded_hand', enabled: true, approved_at: '2026-09-29T22:44:13+00:00', description: 'hands' },
    { mode: 'puzzle_nuts', enabled: false, approved_at: null, description: 'puzzles' },
  ]);
}

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
  return c as unknown as Parameters<typeof fleetWeeklyDigest>[0] & { readonly captured: { body: unknown; status: number } };
}

async function fire(query: Record<string, string> = {}) {
  const c = context(query);
  await fleetWeeklyDigest(c);
  return c.captured;
}

async function live(): Promise<DigestResult> {
  return (await fire()).body as DigestResult;
}

async function dryRun(query: Record<string, string> = {}): Promise<DigestResult> {
  return (await fire({ dry_run: '1', ...query })).body as DigestResult;
}

function okResponse(body: unknown = { id: 'email_01HZZ' }) {
  return { ok: true, status: 200, json: async () => body };
}

function sentMail(): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const call = fetcher.mock.calls[0] as [string, RequestInit] | undefined;
  if (!call) throw new Error('fetch was not called');
  return { url: call[0], init: call[1], body: JSON.parse(String(call[1].body)) as Record<string, unknown> };
}

function sample(name: string, content: string): void {
  const dir = process.env.P10_SAMPLES_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

let db: FakeDb;
let fetcher: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  db = new FakeDb();
  h.db = db;
  seedModes();
  h.rpc.mockResolvedValue({ data: fixture(), error: null });
  h.engineSwitch.mockResolvedValue('on');
  fetcher = vi.fn().mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetcher);
  vi.stubEnv('FLEET_DIGEST_EMAIL', RECIPIENTS);
  vi.stubEnv('RESEND_API_KEY', KEY);
  vi.stubEnv('RESEND_FROM_EMAIL', '');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('the gates: recipient and key', () => {
  it('recipient unset (variable absent): 200, skipped recipient_unset, the figures computed, fetch never called', async () => {
    delete process.env.FLEET_DIGEST_EMAIL;
    const captured = await fire();
    expect(captured.status).toBe(200);
    const body = captured.body as DigestResult;
    expect(body).toMatchObject({ ok: true, dry_run: false, skipped: 'recipient_unset', sent: 0, recipients: 0, engine: 'on' });
    expect(body.resend_id).toBeUndefined();
    expect(body.text).toBeUndefined();
    expect(body.subject).toBe('Smarter.Poker fleet digest, week to 2026-10-06');
    expect(body.metrics.posts).toEqual({ horse_posts: 1240, horses_posted: 615 });
    expect(body.notes.join(' ')).toContain('FLEET_DIGEST_EMAIL is unset');
    expect(fetcher).not.toHaveBeenCalled();
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith('fn_fleet_content_metrics', { p_days: 7 });
    expect(h.engineSwitch).toHaveBeenCalledWith({ fresh: true });
  });

  it('recipient blank (only whitespace and commas) is unset too', async () => {
    vi.stubEnv('FLEET_DIGEST_EMAIL', ' , ,  ');
    const body = await live();
    expect(body).toMatchObject({ skipped: 'recipient_unset', sent: 0, recipients: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('key unset: 200, skipped resend_key_unset, the recipient count reported, fetch never called', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const captured = await fire();
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({ ok: true, skipped: 'resend_key_unset', sent: 0, recipients: 2 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('a skip never carries an address or the key into the log', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const json = JSON.stringify((await fire()).body);
    for (const address of ADDRESSES) expect(json).not.toContain(address);
    expect(json).not.toContain(KEY);
  });
});

describe('dry run', () => {
  it('dry_run=1 renders the subject and the text, says sent 0 with the writes note, and never calls fetch', async () => {
    const captured = await fire({ dry_run: '1' });
    expect(captured.status).toBe(200);
    const body = captured.body as DigestResult;
    expect(body).toMatchObject({ ok: true, dry_run: true, sent: 0, recipients: 2, engine: 'on' });
    expect(body.skipped).toBeUndefined();
    expect(body.notes).toContain(DRY_RUN_WRITES_NOTE);
    expect(body.subject).toBe('Smarter.Poker fleet digest, week to 2026-10-06');
    expect(body.text).toContain('Smarter.Poker fleet content digest');
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(body).length).toBeLessThan(8_000);
  });

  it('preview=1 is the same dry run', async () => {
    const body = (await fire({ preview: '1' })).body as DigestResult;
    expect(body).toMatchObject({ dry_run: true, sent: 0 });
    expect(typeof body.text).toBe('string');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('a dry run with the recipient unset still renders (the figures are the point) and sends nothing', async () => {
    delete process.env.FLEET_DIGEST_EMAIL;
    const body = await dryRun();
    expect(body).toMatchObject({ dry_run: true, sent: 0, recipients: 0 });
    expect(body.skipped).toBeUndefined();
    expect(typeof body.text).toBe('string');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('a live run', () => {
  it('posts exactly once to Resend with bearer auth, the to array, the subject and the text, and reports sent 1', async () => {
    const captured = await fire();
    expect(captured.status).toBe(200);
    const body = captured.body as DigestResult;
    expect(body).toMatchObject({ ok: true, dry_run: false, sent: 1, recipients: 2, resend_id: 'email_01HZZ', engine: 'on' });
    expect(body.skipped).toBeUndefined();
    expect(body.text).toBeUndefined();
    expect(body.window).toEqual({ days: 7, since: '2026-09-29T09:30:00+00:00', until: '2026-10-06T09:30:00+00:00' });
    expect(body.modes_on).toEqual(['grounded_hand', 'poker_news']);
    expect(body.modes_off).toEqual(['hand_clip', 'puzzle_nuts']);
    expect(body.timestamp).toBe(NOW.toISOString());

    expect(fetcher).toHaveBeenCalledTimes(1);
    const mail = sentMail();
    expect(mail.url).toBe('https://api.resend.com/emails');
    expect(mail.url).toBe(RESEND_URL);
    expect(mail.init.method).toBe('POST');
    expect(mail.init.headers).toEqual({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
    expect(mail.init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(mail.body).sort()).toEqual(['from', 'subject', 'text', 'to']);
    expect(mail.body.from).toBe(DEFAULT_FROM_EMAIL);
    expect(mail.body.to).toEqual(ADDRESSES);
    expect(mail.body.subject).toBe(body.subject);
    expect(String(mail.body.text)).toContain('Smarter.Poker fleet content digest');

    const json = JSON.stringify(body);
    expect(json.length).toBeLessThan(8_000);
    for (const address of ADDRESSES) expect(json).not.toContain(address);
    expect(json).not.toContain(KEY);
  });

  it('RESEND_FROM_EMAIL, trimmed, is the sender when set', async () => {
    vi.stubEnv('RESEND_FROM_EMAIL', '  Fleet Digest <digest@example.test>  ');
    await live();
    expect(sentMail().body.from).toBe('Fleet Digest <digest@example.test>');
  });

  it('a Resend answer without an id is still sent 1, without resend_id', async () => {
    fetcher.mockResolvedValue(okResponse({}));
    const body = await live();
    expect(body.sent).toBe(1);
    expect(body.resend_id).toBeUndefined();
  });

  it('an unparseable Resend answer body is still sent 1', async () => {
    fetcher.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError('not json'); } });
    const body = await live();
    expect(body.sent).toBe(1);
  });

  it('a Resend 500 is a 500 with the status in error, no key, no response body, and no second attempt', async () => {
    fetcher.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ message: 'BODY-MARKER-NEVER-LOGGED' }),
      text: async () => 'BODY-MARKER-NEVER-LOGGED',
    });
    const captured = await fire();
    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({ ok: false, error: 'resend HTTP 500' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('a Resend 422 (a bad address) is a loud 500 too', async () => {
    fetcher.mockResolvedValue({ ok: false, status: 422 });
    const captured = await fire();
    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({ ok: false, error: 'resend HTTP 422' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('a timeout (the AbortSignal ceiling) is a 500 naming the timeout, with no second attempt', async () => {
    fetcher.mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    const captured = await fire();
    expect(captured.status).toBe(500);
    const body = captured.body as { ok: false; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/^resend request failed before a response: TimeoutError: /);
    expect(body.error).not.toContain(KEY);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('a network failure names its cause code and redacts the key and the addresses', async () => {
    fetcher.mockRejectedValue(Object.assign(
      new TypeError(`fetch failed for ${ADDRESSES[0]} with ${KEY}`),
      { cause: { code: 'ENOTFOUND' } },
    ));
    const captured = await fire();
    expect(captured.status).toBe(500);
    const error = (captured.body as { error: string }).error;
    expect(error).toContain('(ENOTFOUND)');
    expect(error).toContain('[redacted]');
    expect(error).not.toContain(KEY);
    for (const address of ADDRESSES) expect(error).not.toContain(address);
  });

  it('past the deadline nothing is sent: skipped deadline', async () => {
    // The clock is read twice before the send: once at the start, once at the deadline check.
    const ticks = [0, DEADLINE_MS + 1];
    const clock = () => ticks.shift() ?? DEADLINE_MS + 2;
    const body = await runDigest({ dryRun: false, now: NOW, clock });
    expect(body).toMatchObject({ ok: true, skipped: 'deadline', sent: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(DEADLINE_MS).toBe(90_000);
    expect(RESEND_TIMEOUT_MS).toBe(30_000);
    expect(WINDOW_DAYS).toBe(7);
  });
});

describe('the reads', () => {
  it('an RPC error is a 500 naming the function; nothing else is read and nothing is sent', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'permission denied for function fn_fleet_content_metrics' } });
    const captured = await fire();
    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({ ok: false, error: 'fn_fleet_content_metrics failed: permission denied for function fn_fleet_content_metrics' });
    expect(h.engineSwitch).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('an RPC that throws (the client ceiling) is a 500 with that message', async () => {
    h.rpc.mockRejectedValue(new Error('supabase request exceeded 20000ms and was aborted: https://db.example.test/rest/v1/rpc/fn_fleet_content_metrics'));
    const captured = await fire();
    expect(captured.status).toBe(500);
    expect((captured.body as { error: string }).error).toContain('exceeded 20000ms');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('an empty payload (the function returned NULL) is a 500, never a mail of zeros', async () => {
    h.rpc.mockResolvedValue({ data: null, error: null });
    const captured = await fire();
    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({ ok: false, error: 'fn_fleet_content_metrics returned no payload' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('a horse_post_modes read failure is a 500 and nothing is sent', async () => {
    db.fail((op) => op.table === 'horse_post_modes');
    const captured = await fire();
    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({ ok: false, error: 'horse_post_modes read failed: simulated outage' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the mode rows with their approval column, ordered by mode, and flips nothing', async () => {
    await live();
    const reads = db.log.filter((op) => op.table === 'horse_post_modes');
    expect(reads).toHaveLength(1);
    expect(reads[0]?.kind).toBe('select');
    expect(db.writes('horse_post_modes', 'update')).toHaveLength(0);
    expect(db.log.filter((op) => op.kind !== 'select')).toHaveLength(0);
  });

  it('a payload missing keys prints n/a for them, never NaN, null or undefined, and still sends', async () => {
    h.rpc.mockResolvedValue({ data: { window: fixture().window, posts: { horse_posts: 5 } }, error: null });
    const body = await live();
    expect(body.sent).toBe(1);
    const text = String(sentMail().body.text);
    expect(text).toContain('  Horse posts: 5 from n/a horses');
    expect(text).toContain('  Fleet coverage: n/a of n/a schedulable horses (n/a); n/a of 1,000');
    expect(text).toContain('  (the payload carried no run rows)');
    expect(text).not.toMatch(/NaN|undefined|\bnull\b/);
  });

  it('a payload without a window takes the fire time as until and seven days before as since', async () => {
    const payload: Partial<ReturnType<typeof fixture>> = fixture();
    delete payload.window;
    h.rpc.mockResolvedValue({ data: payload, error: null });
    const body = await live();
    expect(body.window).toEqual({ days: 7, since: '2026-09-29T09:30:07.000Z', until: NOW.toISOString() });
  });
});

describe('the switch states are reported, never obeyed', () => {
  it('engine off: the mail still goes, and says OFF', async () => {
    h.engineSwitch.mockResolvedValue('off');
    const body = await live();
    expect(body).toMatchObject({ sent: 1, engine: 'off' });
    expect(String(sentMail().body.text)).toContain('  Master switch (content_settings.engine_enabled): OFF');
  });

  it('engine unreadable: the mail still goes, and says UNREADABLE', async () => {
    h.engineSwitch.mockResolvedValue('unreadable');
    const body = await live();
    expect(body).toMatchObject({ sent: 1, engine: 'unreadable' });
    expect(String(sentMail().body.text)).toContain('  Master switch (content_settings.engine_enabled): UNREADABLE');
  });

  it('engine on says ON, and the modes are listed on and off in mode order', async () => {
    await live();
    const text = String(sentMail().body.text);
    expect(text).toContain('  Master switch (content_settings.engine_enabled): ON');
    expect(text).toContain('  Modes on: 2 of 4 (grounded_hand, poker_news)');
    expect(text).toContain('  Modes off: hand_clip, puzzle_nuts');
  });

  it('no mode rows at all: 0 of 0, none and none', async () => {
    db.rows('horse_post_modes').length = 0;
    await live();
    const text = String(sentMail().body.text);
    expect(text).toContain('  Modes on: 0 of 0 (none)');
    expect(text).toContain('  Modes off: none');
  });

  it('a mode name carrying a dash or an emoji is scrubbed, so the output law holds whatever the table holds', async () => {
    db.seed('horse_post_modes', [{ mode: 'late\u2014night \u{1F600}', enabled: true, approved_at: null }]);
    await live();
    const text = String(sentMail().body.text);
    expect(text).toContain('late-night');
    expect(CAPTION_EMOJI.test(text)).toBe(false);
    expect(CAPTION_DASHES.test(text)).toBe(false);
  });
});

describe('the mail', () => {
  it('contains every figure of the fixture, line by line, and matches the output law regexes nowhere', async () => {
    const body = await dryRun();
    const text = body.text ?? '';
    sample('sample-digest.txt', `Subject: ${body.subject}\n\n${text}`);
    sample('sample-dry-run.json', `${JSON.stringify(body, null, 2)}\n`);

    expect(body.subject).toBe('Smarter.Poker fleet digest, week to 2026-10-06');
    expect(text.split('\n')[0]).toBe('Smarter.Poker fleet content digest');
    expect(text).toContain('Window: 2026-09-29 09:30 to 2026-10-06 09:30 UTC (7 days). Sent 2026-10-06 09:30 UTC.');
    expect(text).toContain('  Model spend: none (no language model is called)');

    const line = (route: string) => text.split('\n').find((l) => l.startsWith(`  ${route} `)) ?? `(no line for ${route})`;
    expect(line('Route')).toMatch(/^ {2}Route\s+Runs\s+OK\s+Err\s+Killed\s+Skipped\(engine off\)\s+Due\s+Posted\s+Failed\s+Collided$/);
    expect(line('horse-posts')).toMatch(/^ {2}horse-posts\s+168\s+160\s+5\s+3\s+21\(20\)\s+1300\s+1180\s+40\s+6$/);
    expect(line('horse-video-reels')).toMatch(/^ {2}horse-video-reels\s+167\s+165\s+2\s+0\s+22\(19\)\s+410\s+96\s+9\s+-$/);
    expect(line('horses-social-all')).toMatch(/^ {2}horses-social-all\s+166\s+164\s+1\s+1\s+23\(23\)\s+-\s+-\s+-\s+-$/);
    expect(line('horses-social-friends')).toMatch(/^ {2}horses-social-friends\s+24\s+24\s+0\s+0\s+3\(3\)\s+-\s+-\s+-\s+-$/);
    expect(line('horses-stories')).toMatch(/^ {2}horses-stories\s+165\s+163\s+2\s+0\s+24\(18\)\s+-\s+88\s+-\s+-$/);
    expect(line('phase6-content')).toMatch(/^ {2}phase6-content\s+164\s+162\s+2\s+0\s+25\(17\)\s+-\s+73\s+-\s+-$/);
    expect(line('phase7-content')).toMatch(/^ {2}phase7-content\s+163\s+161\s+2\s+0\s+26\(16\)\s+-\s+-\s+-\s+-$/);
    expect(line('phase9-content')).toMatch(/^ {2}phase9-content\s+162\s+159\s+2\s+1\s+27\(15\)\s+-\s+enq 7\s+-\s+-$/);

    for (const expected of [
      '  Horse posts: 1240 from 615 horses',
      '  Fleet coverage: 612 of 938 schedulable horses (65.2%); 61.2% of 1,000',
      '  Horse share of the public feed: 1234 of 1456 posts (84.8%)',
      '  Distinct captions: 1207 of 1230 (98.1%)',
      '  Likes by humans: 321; comments by humans: 57',
      '  Per horse post: 0.306 (over 1234 horse posts)',
      '  Captions: 1180 ledgered, 1150 distinct, 44 rows repeating a key',
      '  Meanings: 1100 ledgered, 980 distinct, 210 repeating',
      '  Frames: 1210 ledgered, 310 distinct, 1030 repeating (reuse after 3 hours is by design)',
      '  Assets: 877 used, 851 distinct',
      '  Horses not social ready (fn_horses_not_social_ready): 62',
      'Figures come from fn_fleet_content_metrics(7); the horses admin page shows the same numbers.',
    ]) {
      expect(text).toContain(expected);
    }

    // The safety net under the lines above: every non-zero figure of the payload, formatted as the mail formats it.
    let checked = 0;
    const walk = (value: unknown, key: string): void => {
      if (typeof value === 'number') {
        if (value === 0) return;
        const token = key.endsWith('_pct') ? `${value.toFixed(1)}%` : key.startsWith('per_') ? value.toFixed(3) : String(value);
        expect(text, `${key} = ${token}`).toContain(token);
        checked += 1;
      } else if (Array.isArray(value)) {
        value.forEach((item) => walk(item, key));
      } else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, k);
      }
    };
    walk(fixture(), '');
    // 18 scalar figures, 52 non-zero run cells, 9 phrase figures, 2 asset figures.
    expect(checked).toBe(81);

    for (const output of [body.subject, text]) {
      expect(CAPTION_EMOJI.test(output)).toBe(false);
      expect(CAPTION_DASHES.test(output)).toBe(false);
    }
    expect(text).not.toMatch(/\bbot\b/i);
  });

  it('prints a non-zero figure even in a column the route is not known to report, and every column of an unknown route', () => {
    const payload = fixture();
    payload.runs = [
      run('/cron/horses-stories', { runs: 10, succeeded: 10, failed: 3 }),
      run('/cron/new-thing', { runs: 2, succeeded: 2, due: 4, posted: 3, failed: 1, collided: 0, enqueued: 0 }),
    ];
    const { text } = renderDigest(parseMetrics(payload), { engine: 'on', modes: [] }, { days: 7, since: '', until: '', sent_at: NOW.toISOString() });
    const line = (route: string) => text.split('\n').find((l) => l.startsWith(`  ${route} `)) ?? '';
    // horses-stories reports posted (so its 0 is printed) and not failed (so a non-zero 3 is printed anyway).
    expect(line('horses-stories')).toMatch(/^ {2}horses-stories\s+10\s+10\s+0\s+0\s+0\(0\)\s+-\s+0\s+3\s+-$/);
    expect(line('new-thing')).toMatch(/^ {2}new-thing\s+2\s+2\s+0\s+0\s+0\(0\)\s+4\s+3\s+1\s+0$/);
  });

  it('renderDigest is pure: the same inputs give the same mail twice, and it reads no environment', () => {
    const metrics = parseMetrics(fixture());
    const window = { days: 7, since: '2026-09-29T09:30:00+00:00', until: '2026-10-06T09:30:00+00:00', sent_at: NOW.toISOString() };
    const switches = { engine: 'on' as const, modes: [{ mode: 'hand_clip', enabled: false, approved_at: null }] };
    expect(renderDigest(metrics, switches, window)).toEqual(renderDigest(metrics, switches, window));
  });

  it('splits FLEET_DIGEST_EMAIL on commas, trims, and drops blanks', () => {
    expect(parseRecipients(undefined)).toEqual([]);
    expect(parseRecipients('')).toEqual([]);
    expect(parseRecipients(' a@example.test ')).toEqual(['a@example.test']);
    expect(parseRecipients(' a@example.test , b@example.test,, ')).toEqual(['a@example.test', 'b@example.test']);
  });

  it('names the function the figures come from', () => {
    expect(METRICS_FUNCTION).toBe('fn_fleet_content_metrics');
  });
});

describe('wiring and laws (static)', () => {
  const route = readFileSync(new URL('./fleet-weekly-digest.ts', import.meta.url), 'utf8');
  const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const phase9 = readFileSync(new URL('./phase9-content.ts', import.meta.url), 'utf8');
  const envExample = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');

  it('is registered for GET and POST behind the cron guards, right after the Phase 9 route', () => {
    expect(index).toContain("import { fleetWeeklyDigest } from './routes/fleet-weekly-digest.js';");
    const ipGuard = index.indexOf("app.use('/cron/*', ipAllowlist);");
    const secretGuard = index.indexOf("app.use('/cron/*', requireCronSecret);");
    const logMiddleware = index.indexOf(".from('cron_execution_log')");
    const phase9Post = index.indexOf("app.post('/cron/phase9-content', phase9Content);");
    const getRoute = index.indexOf("app.get('/cron/fleet-weekly-digest', fleetWeeklyDigest);");
    const postRoute = index.indexOf("app.post('/cron/fleet-weekly-digest', fleetWeeklyDigest);");
    expect(ipGuard).toBeGreaterThan(-1);
    expect(secretGuard).toBeGreaterThan(ipGuard);
    expect(logMiddleware).toBeGreaterThan(secretGuard);
    expect(phase9Post).toBeGreaterThan(logMiddleware);
    expect(getRoute).toBeGreaterThan(phase9Post);
    expect(getRoute - phase9Post).toBeLessThan(400);
    expect(postRoute).toBeGreaterThan(getRoute);
    expect(index.match(/fleet-weekly-digest/g)).toHaveLength(3);
  });

  it('takes the switch from Fleet, the figures from one RPC, sends with one fetch, and writes nothing', () => {
    expect(route).toContain("import { engineSwitch, type EngineSwitchState } from '../lib/content-engine/Fleet.js';");
    expect(route).toContain("import { getSupabase } from '../lib/supabase.js';");
    expect(route.match(/\.rpc\(/g)).toHaveLength(1);
    expect(route).toContain('.rpc(METRICS_FUNCTION, { p_days: WINDOW_DAYS })');
    expect(route).toContain("'https://api.resend.com/emails'");
    expect(route.match(/\bfetch\(/g)).toHaveLength(1);
    expect(route).toContain('signal: AbortSignal.timeout(RESEND_TIMEOUT_MS)');
    expect(route).not.toMatch(/\.(?:insert|update|upsert|delete)\(/);
    expect(route).not.toMatch(/from\('(?:social_posts|social_reels|content_settings|profiles|cron_execution_log)'\)/);
    expect(route).not.toMatch(/\bset(?:Timeout|Interval|Immediate)\b|\bretry\b|\bwhile \(true\)/i);
    expect(route).not.toMatch(/from 'resend'|require\('resend'\)/);
    // The dry run returns before the gates, and the gates before the only send.
    expect(route.indexOf('if (options.dryRun) {')).toBeLessThan(route.indexOf("finish('recipient_unset')"));
    expect(route.indexOf("finish('recipient_unset')")).toBeLessThan(route.indexOf("finish('resend_key_unset')"));
    expect(route.indexOf("finish('resend_key_unset')")).toBeLessThan(route.indexOf('await sendDigest('));
  });

  it('has no recipient of its own: FLEET_DIGEST_EMAIL has no default, and the only literal address is the sender', () => {
    expect(route).toContain('process.env.FLEET_DIGEST_EMAIL');
    expect(route).not.toMatch(/FLEET_DIGEST_EMAIL\s*(?:\?\?|\|\|)/);
    expect(route).toMatch(/parseRecipients\(process\.env\.FLEET_DIGEST_EMAIL\)/);
    const addresses = new Set(route.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []);
    expect([...addresses]).toEqual(['alerts@smarter.poker']);
    expect(route).toContain("DEFAULT_FROM_EMAIL = 'alerts@smarter.poker'");
  });

  it('pins the Phase 6 output law regexes exactly as phase9-content.ts has them', () => {
    // Source text, not .source: the bundler rewrites the escapes in the compiled literal.
    for (const source of [phase9, route]) {
      expect(source).toContain('= /\\p{Extended_Pictographic}/u;');
      expect(source).toContain('= /[\\u2013\\u2014]/;');
    }
    expect(CAPTION_EMOJI.flags).toBe('u');
    expect(CAPTION_DASHES.test('-')).toBe(false);
    expect(CAPTION_DASHES.test('\u2013')).toBe(true);
    expect(CAPTION_DASHES.test('\u2014')).toBe(true);
  });

  it('every fixed word of the template is plain text: no dash, no emoji, no bots', () => {
    for (const source of [route]) {
      expect(CAPTION_EMOJI.test(source)).toBe(false);
      expect(CAPTION_DASHES.test(source)).toBe(false);
      expect(source).not.toMatch(/\bbots?\b/i);
    }
  });

  it('names both variables, blank, in .env.example and in the docker-compose comment list', () => {
    expect(envExample).toMatch(/^RESEND_FROM_EMAIL=$/m);
    expect(envExample).toMatch(/^FLEET_DIGEST_EMAIL=$/m);
    expect(envExample).toMatch(/^RESEND_API_KEY=$/m);
    expect(compose).toMatch(/^# {3}RESEND_FROM_EMAIL=</m);
    expect(compose).toMatch(/^# {3}FLEET_DIGEST_EMAIL=</m);
    // The lines this phase added (the files' older headers are not this phase's to edit).
    const added = [...envExample.split('\n'), ...compose.split('\n')]
      .filter((line) => /RESEND_FROM_EMAIL|FLEET_DIGEST_EMAIL|weekly fleet digest/i.test(line));
    expect(added.length).toBeGreaterThanOrEqual(6);
    for (const line of added) {
      expect(CAPTION_DASHES.test(line), line).toBe(false);
      expect(CAPTION_EMOJI.test(line), line).toBe(false);
    }
  });
});
