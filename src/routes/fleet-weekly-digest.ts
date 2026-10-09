/**
 * GET/POST /cron/fleet-weekly-digest
 *
 * Phase 10 of the Fleet Content Programme: the Monday mail. One fire reads
 * last week's figures and sends them to the owner as plain text. It is a
 * report, not a publisher: the master switch and the mode rows are figures
 * it prints, not gates it obeys, because a week in which the engine was off
 * must still arrive as a digest that says so (programme invariant 7: a run
 * that did nothing says so). The only gate is the recipient.
 *
 * One fire, in this order:
 *   1. FLEET_DIGEST_EMAIL, RESEND_API_KEY and RESEND_FROM_EMAIL are read at
 *      call time, never at import, as every integration in this service
 *      reads its variables;
 *   2. one RPC, fn_fleet_content_metrics(7): the fleet runs per route from
 *      cron_execution_log, horse posts and distinct horses, horse share of
 *      the feed, human reactions per horse post, the distinct-caption rate,
 *      fleet coverage, the phrase and asset ledgers, and the
 *      fn_horses_not_social_ready() count. The function is SECURITY DEFINER
 *      and service_role only; this client holds the service role. An error
 *      or an empty payload throws, so the fire is a 500 and the cron log
 *      shows an error, not a quiet fire;
 *   3. the master switch through engineSwitch({ fresh: true }), the reader
 *      the fleet itself obeys, so the mail reports what the fleet saw; then
 *      every horse_post_modes row (mode, enabled, approved_at). Nothing is
 *      flipped: approving a mode is the owner's hold;
 *   4. the digest is rendered by a pure function over numbers, route names,
 *      mode names and fixed words. No model is called. Route and mode names
 *      are scrubbed of the two dashes and of emoji, so the output law the
 *      Phase 6 voices pin (HandVoice.ts, phase9-content.ts) holds by
 *      construction;
 *   5. `?dry_run=1` (or `?preview=1`, the Phase 7 spelling) returns the
 *      figures, the subject and the text, and sends nothing;
 *   6. an unset recipient is a 200 with skipped 'recipient_unset' and the
 *      figures still computed, so the first Monday fire is visible in
 *      cron_execution_log as a measured no-op; an unset key is
 *      'resend_key_unset'. Neither falls back to another address;
 *   7. one POST to the Resend API with the key as a bearer token, the
 *      recipients as an array, the subject and the text, under a 30 s
 *      ceiling. A non-2xx answer or a thrown request is a 500 whose error
 *      names the HTTP status, never the key and never the response body,
 *      and the mail is never sent twice: what one fire fails to send, the
 *      next Monday sends with the next week's figures.
 *
 * Writes nothing but that one email. The only database write is the cron
 * middleware logging this request in cron_execution_log, whose result column
 * gets this route's JSON: counts and the subject, never an address, never
 * the key, and the text only on a dry run (the log keeps 8 KB).
 *
 * Registered exactly like the Phase 9 route (src/index.ts): behind the IP
 * allowlist and the cron secret. The dispatcher entry (Monday 09:30 UTC) is
 * the World Hub's half of this phase.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { engineSwitch, type EngineSwitchState } from '../lib/content-engine/Fleet.js';

export const METRICS_FUNCTION = 'fn_fleet_content_metrics';
/** The rolling window the horses admin page uses too, so the mail and the page agree. */
export const WINDOW_DAYS = 7;
/** Inside the dispatcher's 120 s default budget: one RPC, two small reads, one POST. */
export const DEADLINE_MS = 90_000;
/** The ceiling on the one Resend call. */
export const RESEND_TIMEOUT_MS = 30_000;
export const RESEND_URL = 'https://api.resend.com/emails';
/** The hub's ops-mail sender; RESEND_FROM_EMAIL overrides it. */
export const DEFAULT_FROM_EMAIL = 'alerts@smarter.poker';

export const DRY_RUN_WRITES_NOTE =
  'Dry run sends nothing: no Resend call, no write. '
  + 'The only write is the cron middleware logging this request in cron_execution_log.';

/** The Phase 6 output law, as HandVoice.ts and phase9-content.ts pin it. */
export const CAPTION_EMOJI = /\p{Extended_Pictographic}/u;
export const CAPTION_DASHES = /[\u2013\u2014]/;

type Supa = ReturnType<typeof getSupabase>;

/** A number the RPC gave, or null when the key was missing or not numeric (printed as n/a, never invented). */
export type Figure = number | null;

export interface RunRow {
  job_name: string;
  runs: Figure;
  succeeded: Figure;
  errored: Figure;
  killed: Figure;
  skipped_runs: Figure;
  engine_off_runs: Figure;
  due: Figure;
  posted: Figure;
  failed: Figure;
  collided: Figure;
  enqueued: Figure;
}

export interface PhraseRow {
  kind: string;
  rows_written: Figure;
  distinct_keys: Figure;
  rows_that_repeat: Figure;
}

/** The RPC payload (rpc-contract.md), minus its window, which the result carries at the top level. */
export interface FleetMetrics {
  feed: { horse_posts: Figure; feed_posts: Figure; horse_share_pct: Figure };
  reactions: { human_likes: Figure; human_comments: Figure; horse_posts: Figure; per_horse_post: Figure };
  captions: { horse_posts: Figure; distinct_captions: Figure; distinct_caption_pct: Figure };
  coverage: { horses_posted: Figure; fleet_size: Figure; coverage_pct: Figure; coverage_pct_of_1000: Figure };
  readiness: { horses_not_social_ready: Figure };
  posts: { horse_posts: Figure; horses_posted: Figure };
  runs: RunRow[];
  ledger: { phrases: PhraseRow[]; assets: { rows: Figure; distinct: Figure } };
}

export interface ModeRow {
  mode: string;
  enabled: boolean;
  approved_at: string | null;
}

export interface Switches {
  engine: EngineSwitchState;
  modes: ModeRow[];
}

export interface DigestWindow {
  days: number;
  since: string;
  until: string;
  /** When the digest was rendered: the fire. */
  sent_at: string;
}

export type DigestSkip = 'recipient_unset' | 'resend_key_unset' | 'deadline';

export interface DigestResult {
  ok: true;
  dry_run: boolean;
  window: { days: number; since: string; until: string };
  /** Emails sent: one mail, however many recipients. */
  sent: 0 | 1;
  /** How many addresses FLEET_DIGEST_EMAIL names: a count, never the addresses. */
  recipients: number;
  resend_id?: string;
  skipped?: DigestSkip;
  engine: EngineSwitchState;
  modes_on: string[];
  modes_off: string[];
  metrics: FleetMetrics;
  subject: string;
  /** The rendered mail, on a dry run only: the cron log keeps 8 KB. */
  text?: string;
  notes: string[];
  duration_ms: number;
  timestamp: string;
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function figure(value: unknown): Figure {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

// ---------------------------------------------------------------------------
// The payload (pure)
// ---------------------------------------------------------------------------

function parseRun(raw: unknown): RunRow[] {
  const row = record(raw);
  const jobName = text(row.job_name);
  if (!jobName) return [];
  return [{
    job_name: jobName,
    runs: figure(row.runs),
    succeeded: figure(row.succeeded),
    errored: figure(row.errored),
    killed: figure(row.killed),
    skipped_runs: figure(row.skipped_runs),
    engine_off_runs: figure(row.engine_off_runs),
    due: figure(row.due),
    posted: figure(row.posted),
    failed: figure(row.failed),
    collided: figure(row.collided),
    enqueued: figure(row.enqueued),
  }];
}

function parsePhrase(raw: unknown): PhraseRow[] {
  const row = record(raw);
  const kind = text(row.kind);
  if (!kind) return [];
  return [{
    kind,
    rows_written: figure(row.rows_written),
    distinct_keys: figure(row.distinct_keys),
    rows_that_repeat: figure(row.rows_that_repeat),
  }];
}

/** The RPC payload as the digest needs it. A missing key is null (n/a in the mail); no payload at all throws. */
export function parseMetrics(raw: unknown): FleetMetrics {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${METRICS_FUNCTION} returned no payload`);
  }
  const r = raw as Record<string, unknown>;
  const feed = record(r.feed);
  const reactions = record(r.reactions);
  const captions = record(r.captions);
  const coverage = record(r.coverage);
  const readiness = record(r.readiness);
  const posts = record(r.posts);
  const ledger = record(r.ledger);
  const assets = record(ledger.assets);
  return {
    feed: { horse_posts: figure(feed.horse_posts), feed_posts: figure(feed.feed_posts), horse_share_pct: figure(feed.horse_share_pct) },
    reactions: {
      human_likes: figure(reactions.human_likes),
      human_comments: figure(reactions.human_comments),
      horse_posts: figure(reactions.horse_posts),
      per_horse_post: figure(reactions.per_horse_post),
    },
    captions: {
      horse_posts: figure(captions.horse_posts),
      distinct_captions: figure(captions.distinct_captions),
      distinct_caption_pct: figure(captions.distinct_caption_pct),
    },
    coverage: {
      horses_posted: figure(coverage.horses_posted),
      fleet_size: figure(coverage.fleet_size),
      coverage_pct: figure(coverage.coverage_pct),
      coverage_pct_of_1000: figure(coverage.coverage_pct_of_1000),
    },
    readiness: { horses_not_social_ready: figure(readiness.horses_not_social_ready) },
    posts: { horse_posts: figure(posts.horse_posts), horses_posted: figure(posts.horses_posted) },
    runs: Array.isArray(r.runs) ? r.runs.flatMap(parseRun) : [],
    ledger: {
      phrases: Array.isArray(ledger.phrases) ? ledger.phrases.flatMap(parsePhrase) : [],
      assets: { rows: figure(assets.rows), distinct: figure(assets.distinct) },
    },
  };
}

/** The window the RPC measured (its own clock); the route's clock only fills a missing key. */
export function readWindow(raw: unknown, now: Date): DigestWindow {
  const w = record(record(raw).window);
  const days = figure(w.days) ?? WINDOW_DAYS;
  const until = text(w.until) ?? now.toISOString();
  const untilMs = Date.parse(until);
  const since = text(w.since)
    ?? new Date((Number.isNaN(untilMs) ? now.getTime() : untilMs) - days * 86_400_000).toISOString();
  return { days, since, until, sent_at: now.toISOString() };
}

// ---------------------------------------------------------------------------
// The mail (pure, no model call)
// ---------------------------------------------------------------------------

/** Route and mode names come from the database; the law holds whatever they hold. */
function plain(value: string): string {
  return value
    .replace(new RegExp(CAPTION_DASHES.source, 'g'), '-')
    .replace(new RegExp(CAPTION_EMOJI.source, 'gu'), '')
    .trim();
}

function count(value: Figure): string {
  return value === null ? 'n/a' : String(value);
}

function pct(value: Figure): string {
  return value === null ? 'n/a' : `${value.toFixed(1)}%`;
}

function per(value: Figure): string {
  return value === null ? 'n/a' : value.toFixed(3);
}

/** 2026-10-06T09:30:00+00:00 -> "2026-10-06 09:30"; an unparseable stamp is printed as given. */
function stamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return plain(iso);
  const s = new Date(t).toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 16)}`;
}

function day(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? plain(iso) : new Date(t).toISOString().slice(0, 10);
}

const ENGINE_WORDS: Readonly<Record<EngineSwitchState, string>> = { on: 'ON', off: 'OFF', unreadable: 'UNREADABLE' };

type RunColumn = 'due' | 'posted' | 'failed' | 'collided' | 'enqueued';

/**
 * Which of the summed result keys each fleet route writes at the top level
 * of its JSON (the RPC sums only those). A column a route does not report is
 * printed as "-" rather than as a zero it never counted; a non-zero figure is
 * printed whatever this table says, so nothing is hidden. A route this table
 * does not know prints every column.
 *   horse-posts.ts:136-146 (due, posted, failed, collided)
 *   horse-video-reels.ts:242-252 (due, posted, failed)
 *   horses-social-all.ts, horses-social-friends.ts (liked, commented, ... only)
 *   horses-stories.ts:263 (posted); phase6-content.ts:717 (posted)
 *   Phase7Content.ts nests its counts under reveals and the story modes
 *   phase9-content.ts:117 (enqueued)
 */
const REPORTED_COLUMNS: Readonly<Record<string, readonly RunColumn[]>> = {
  '/cron/horse-posts': ['due', 'posted', 'failed', 'collided'],
  '/cron/horse-video-reels': ['due', 'posted', 'failed'],
  '/cron/horses-social-all': [],
  '/cron/horses-social-friends': [],
  '/cron/horses-stories': ['posted'],
  '/cron/phase6-content': ['posted'],
  '/cron/phase7-content': [],
  '/cron/phase9-content': ['enqueued'],
};

function runCell(row: RunRow, column: RunColumn): string {
  const value = row[column];
  const reported = REPORTED_COLUMNS[row.job_name];
  if (reported && !reported.includes(column) && (value === null || value === 0)) return '-';
  return count(value);
}

function postedCell(row: RunRow): string {
  const reported = REPORTED_COLUMNS[row.job_name];
  if (reported && reported.includes('enqueued')) return `enq ${count(row.enqueued)}`;
  return runCell(row, 'posted');
}

function routeLabel(jobName: string): string {
  return plain(jobName.startsWith('/cron/') ? jobName.slice('/cron/'.length) : jobName);
}

/** Left-aligned columns, two spaces apart, two spaces of indent. */
function table(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, cell.length); });
  }
  return rows.map((row) => `  ${row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ')}`.trimEnd());
}

function phraseRow(metrics: FleetMetrics, kind: string): PhraseRow {
  return metrics.ledger.phrases.find((row) => row.kind === kind)
    ?? { kind, rows_written: null, distinct_keys: null, rows_that_repeat: null };
}

/**
 * The section 5 template of the Phase 10 research: every token is a number
 * from the payload, a route name, a mode name or a fixed word. Pure.
 */
export function renderDigest(metrics: FleetMetrics, switches: Switches, window: DigestWindow): { subject: string; text: string } {
  const on = switches.modes.filter((row) => row.enabled).map((row) => plain(row.mode));
  const off = switches.modes.filter((row) => !row.enabled).map((row) => plain(row.mode));
  const caption = phraseRow(metrics, 'caption');
  const meaning = phraseRow(metrics, 'meaning');
  const frame = phraseRow(metrics, 'frame');

  const runRows = metrics.runs.map((row) => [
    routeLabel(row.job_name),
    count(row.runs),
    count(row.succeeded),
    count(row.errored),
    count(row.killed),
    `${count(row.skipped_runs)}(${count(row.engine_off_runs)})`,
    runCell(row, 'due'),
    postedCell(row),
    runCell(row, 'failed'),
    runCell(row, 'collided'),
  ]);
  const runTable = runRows.length === 0
    ? ['  (the payload carried no run rows)']
    : table([['Route', 'Runs', 'OK', 'Err', 'Killed', 'Skipped(engine off)', 'Due', 'Posted', 'Failed', 'Collided'], ...runRows]);

  const lines = [
    'Smarter.Poker fleet content digest',
    `Window: ${stamp(window.since)} to ${stamp(window.until)} UTC (${window.days} days). Sent ${stamp(window.sent_at)} UTC.`,
    '',
    'Engine',
    `  Master switch (content_settings.engine_enabled): ${ENGINE_WORDS[switches.engine]}`,
    `  Modes on: ${on.length} of ${switches.modes.length} (${on.length ? on.join(', ') : 'none'})`,
    `  Modes off: ${off.length ? off.join(', ') : 'none'}`,
    '  Caption model spend: service-only daily budget ledger (not exposed in this digest)',
    '',
    'Fleet runs this week (cron_execution_log)',
    ...runTable,
    '',
    'Posts',
    `  Horse posts: ${count(metrics.posts.horse_posts)} from ${count(metrics.posts.horses_posted)} horses`,
    `  Fleet coverage: ${count(metrics.coverage.horses_posted)} of ${count(metrics.coverage.fleet_size)} schedulable horses`
      + ` (${pct(metrics.coverage.coverage_pct)}); ${pct(metrics.coverage.coverage_pct_of_1000)} of 1,000`,
    `  Horse share of the public feed: ${count(metrics.feed.horse_posts)} of ${count(metrics.feed.feed_posts)} posts`
      + ` (${pct(metrics.feed.horse_share_pct)})`,
    `  Distinct captions: ${count(metrics.captions.distinct_captions)} of ${count(metrics.captions.horse_posts)}`
      + ` (${pct(metrics.captions.distinct_caption_pct)})`,
    '',
    'Humans reacting to horse posts',
    `  Likes by humans: ${count(metrics.reactions.human_likes)}; comments by humans: ${count(metrics.reactions.human_comments)}`,
    `  Per horse post: ${per(metrics.reactions.per_horse_post)} (over ${count(metrics.reactions.horse_posts)} horse posts)`,
    '',
    'Ledgers',
    `  Captions: ${count(caption.rows_written)} ledgered, ${count(caption.distinct_keys)} distinct,`
      + ` ${count(caption.rows_that_repeat)} rows repeating a key`,
    `  Meanings: ${count(meaning.rows_written)} ledgered, ${count(meaning.distinct_keys)} distinct,`
      + ` ${count(meaning.rows_that_repeat)} repeating`,
    `  Frames: ${count(frame.rows_written)} ledgered, ${count(frame.distinct_keys)} distinct,`
      + ` ${count(frame.rows_that_repeat)} repeating (reuse after 3 hours is by design)`,
    `  Assets: ${count(metrics.ledger.assets.rows)} used, ${count(metrics.ledger.assets.distinct)} distinct`,
    '',
    'Readiness',
    `  Horses not social ready (fn_horses_not_social_ready): ${count(metrics.readiness.horses_not_social_ready)}`,
    '',
    `Figures come from ${METRICS_FUNCTION}(${window.days}); the horses admin page shows the same numbers.`,
  ];
  return {
    subject: `Smarter.Poker fleet digest, week to ${day(window.until)}`,
    text: `${lines.join('\n')}\n`,
  };
}

// ---------------------------------------------------------------------------
// Reads and the one send
// ---------------------------------------------------------------------------

/** One address, or several separated by commas; blank entries dropped. Nothing is validated here: Resend answers 4xx to a bad address, loudly. */
export function parseRecipients(value: string | undefined): string[] {
  return (value ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
}

async function readMetrics(supa: Supa): Promise<unknown> {
  const { data, error } = await supa.rpc(METRICS_FUNCTION, { p_days: WINDOW_DAYS });
  if (error) throw new Error(`${METRICS_FUNCTION} failed: ${error.message}`);
  return data as unknown;
}

async function readModes(supa: Supa): Promise<ModeRow[]> {
  const { data, error } = await supa.from('horse_post_modes').select('mode, enabled, approved_at').order('mode');
  if (error) throw new Error(`horse_post_modes read failed: ${error.message}`);
  const rows: ModeRow[] = [];
  for (const raw of (data ?? []) as unknown[]) {
    const row = record(raw);
    const mode = text(row.mode);
    if (!mode) continue;
    rows.push({ mode, enabled: row.enabled === true, approved_at: text(row.approved_at) });
  }
  return rows;
}

/** A failure's name, message and cause code with the key and the addresses redacted: this string reaches the log. */
function describeFailure(error: unknown, secrets: string[]): string {
  const name = error instanceof Error ? error.name : 'Error';
  const code = text(record((error as { cause?: unknown } | null)?.cause).code);
  let detail = `${name}: ${message(error)}${code ? ` (${code})` : ''}`;
  for (const secret of secrets) {
    if (secret) detail = detail.split(secret).join('[redacted]');
  }
  return detail;
}

interface Mail {
  key: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
}

/**
 * The one POST. A thrown request (network, the 30 s ceiling) and a non-2xx
 * answer both throw, so the route answers 500 and the log row is an error;
 * the response body is never read into the error, only the status.
 */
async function sendDigest(mail: Mail): Promise<{ id?: string }> {
  let response: Response;
  try {
    response = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mail.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: mail.from, to: mail.to, subject: mail.subject, text: mail.text }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`resend request failed before a response: ${describeFailure(error, [mail.key, ...mail.to])}`);
  }
  if (!response.ok) throw new Error(`resend HTTP ${response.status}`);
  const body: unknown = await response.json().catch(() => null);
  const id = text(record(body).id);
  return id ? { id } : {};
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface RunOptions {
  dryRun: boolean;
  /** Test hooks: the fire time, the wall clock the deadline is measured on, and the budget. */
  now?: Date;
  clock?: () => number;
  deadlineMs?: number;
}

/**
 * One fire: the variables, one RPC, the switch states, the rendering, and at
 * most one send. A read that fails throws, and the route answers 500 so the
 * log shows an error, not a quiet fire.
 */
export async function runDigest(options: RunOptions): Promise<DigestResult> {
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const deadlineMs = options.deadlineMs ?? DEADLINE_MS;
  const now = options.now ?? new Date();

  // 1. The variables, at call time. No default for the recipient, ever.
  const recipients = parseRecipients(process.env.FLEET_DIGEST_EMAIL);
  const key = (process.env.RESEND_API_KEY ?? '').trim();
  const from = (process.env.RESEND_FROM_EMAIL ?? '').trim() || DEFAULT_FROM_EMAIL;

  // 2. One RPC: the week's figures.
  const supa = getSupabase();
  const payload = await readMetrics(supa);
  const metrics = parseMetrics(payload);
  const window = readWindow(payload, now);

  // 3. The switch states, read the way the fleet reads them. Reported, not obeyed.
  const engine = await engineSwitch({ fresh: true });
  const modes = await readModes(supa);

  // 4. The mail.
  const { subject, text: body } = renderDigest(metrics, { engine, modes }, window);

  const result: DigestResult = {
    ok: true,
    dry_run: options.dryRun,
    window: { days: window.days, since: window.since, until: window.until },
    sent: 0,
    recipients: recipients.length,
    engine,
    modes_on: modes.filter((row) => row.enabled).map((row) => row.mode),
    modes_off: modes.filter((row) => !row.enabled).map((row) => row.mode),
    metrics,
    subject,
    notes: [],
    duration_ms: 0,
    timestamp: '',
  };
  const finish = (skipped?: DigestSkip): DigestResult => {
    if (skipped) result.skipped = skipped;
    result.duration_ms = clock() - startedAt;
    result.timestamp = new Date().toISOString();
    return result;
  };

  // 5. A dry run stops here: the figures, the subject and the text, no send.
  if (options.dryRun) {
    result.text = body;
    result.notes.push(DRY_RUN_WRITES_NOTE);
    return finish();
  }

  // 6. The only gates: a recipient and a key. A measured no-op, logged as such.
  if (recipients.length === 0) {
    result.notes.push('FLEET_DIGEST_EMAIL is unset; the figures were computed and nothing was sent');
    return finish('recipient_unset');
  }
  if (!key) {
    result.notes.push('RESEND_API_KEY is unset; the figures were computed and nothing was sent');
    return finish('resend_key_unset');
  }
  if (clock() - startedAt > deadlineMs) {
    result.notes.push(`the reads took longer than ${deadlineMs} ms; nothing was sent`);
    return finish('deadline');
  }

  // 7. One send.
  const sent = await sendDigest({ key, from, to: recipients, subject, text: body });
  result.sent = 1;
  if (sent.id) result.resend_id = sent.id;
  return finish();
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

export async function fleetWeeklyDigest(c: Context) {
  const dryRun = c.req.query('dry_run') === '1' || c.req.query('preview') === '1';
  try {
    return c.json(await runDigest({ dryRun }));
  } catch (error) {
    // The reason never carries the key or an address: the send scrubs both.
    const reason = message(error);
    console.warn('[fleet-weekly-digest] failed:', reason);
    return c.json({ ok: false, error: reason }, 500);
  }
}
