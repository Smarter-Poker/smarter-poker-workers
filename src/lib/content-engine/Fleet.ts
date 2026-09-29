/**
 * Fleet: the whole roster, and the switch that stops it.
 *
 * loadFleet() pages through content_authors so that no `.limit(100)` (or the
 * PostgREST default page of 1,000, which is exactly the fleet size today and
 * one horse from being a silent truncation) decides who exists.
 *
 * A row is on the roster only when its profile says it is a horse
 * (profiles.is_horse) and that horse can be seen (profiles.avatar_url is
 * set, the same test fn_horses_not_social_ready applies). Recertification,
 * 2026-09-21: the roster used to trust content_authors.profile_id alone, so
 * a hand-written row pointing at a person's profile would have posted as
 * that person, and a newborn horse posted before it had a face. Production
 * had 1,000 horses on the roster before this filter and 1,000 after it.
 *
 * engineEnabled() is the kill switch. content_settings.engine_enabled had a
 * column, an admin control and no reader on the live path: the only way to
 * stop the fleet was to edit the dispatcher and redeploy Hetzner. Every
 * fleet route now checks it first and returns `{ skipped: 'engine_disabled' }`
 * so the run is visible in cron_execution_log as a deliberate no-op rather
 * than an absence.
 *
 * Flip it with SQL (the admin panel's write does not reach this table yet,
 * see D-06 in docs/FLEET-CONTENT-PROGRAMME.md):
 *   update content_settings set engine_enabled = false;
 */
import { getSupabase } from '../supabase.js';
import type { FleetHorse } from './HorsePublisher.js';

const PAGE = 500;

export async function loadFleet(): Promise<FleetHorse[]> {
  const supa = getSupabase();
  const out: FleetHorse[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supa
      .from('content_authors')
      .select('id, name, alias, profile_id, timezone, is_active, location, stakes, specialty, personality')
      .eq('is_active', true)
      .not('profile_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`content_authors read failed: ${error.message}`);
    const rows = (data ?? []) as FleetHorse[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  const ready = await postingReadyHorseIds();
  return out.filter((h) => ready.has(h.profile_id));
}

/**
 * Profile ids that may post: profiles.is_horse is true and avatar_url is set.
 *
 * Read completely, keyset-paged on the primary key, so no page clamp decides
 * who is a horse and a profile created mid-read cannot shift a page. This is
 * an allowlist: a horse missing from it is skipped, never a person included.
 * An unreadable page throws, and the caller posts nothing, because a roster
 * that cannot be established is not a roster.
 */
export async function postingReadyHorseIds(): Promise<Set<string>> {
  const supa = getSupabase();
  const ids = new Set<string>();
  let after: string | null = null;
  for (;;) {
    let query = supa
      .from('profiles')
      .select('id')
      .eq('is_horse', true)
      .not('avatar_url', 'is', null);
    if (after !== null) query = query.gt('id', after);
    const { data, error } = await query.order('id', { ascending: true }).limit(PAGE);
    if (error) throw new Error(`horse profile read failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ id: string }>;
    for (const row of rows) ids.add(row.id);
    if (rows.length < PAGE) break;
    after = rows[rows.length - 1]!.id;
  }
  return ids;
}

export type EngineSwitchState = 'on' | 'off' | 'unreadable';

let cachedSwitch: { state: EngineSwitchState; at: number; seq: number } | null = null;
let switchReads = 0;
const SWITCH_TTL_MS = 30_000;

/**
 * True only when content_settings.engine_enabled reads exactly true.
 *
 * `fresh` skips the 30-second cache. A publish run can last nine minutes, so
 * horse-posts asks again before every horse: turning the engine off stops a
 * run in flight, not only the next one.
 */
export async function engineEnabled(opts: { fresh?: boolean } = {}): Promise<boolean> {
  return (await engineSwitch(opts)) === 'on';
}

/** The switch with the reason: a run that stops says whether it was told to. */
export async function engineSwitch(opts: { fresh?: boolean } = {}): Promise<EngineSwitchState> {
  const now = Date.now();
  if (!opts.fresh && cachedSwitch && now - cachedSwitch.at < SWITCH_TTL_MS) return cachedSwitch.state;
  const seq = ++switchReads;
  let state: EngineSwitchState;
  try {
    const { data, error } = await getSupabase()
      .from('content_settings')
      .select('engine_enabled')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    // Fail closed. A kill switch that turns itself ON when its control table
    // cannot be read is not a kill switch. A missed run is recoverable; an
    // uncontrolled fleet is not.
    if (error || !data) {
      console.warn('[fleet] engine switch unreadable; treating the fleet as OFF');
      state = 'unreadable';
    } else {
      state = (data as { engine_enabled: boolean | null }).engine_enabled === true ? 'on' : 'off';
    }
  } catch (err) {
    console.warn('[fleet] engine switch read threw; treating the fleet as OFF:', err instanceof Error ? err.message : err);
    state = 'unreadable';
  }
  // Only the newest read may set the cache. Reads overlap (one route's entry
  // check, another route's loop check); an ON answer that started before an
  // OFF answer must not land last and turn the fleet back on for 30 seconds.
  // A caller whose read was overtaken gets the newer answer.
  if (!cachedSwitch || seq > cachedSwitch.seq) cachedSwitch = { state, at: now, seq };
  return cachedSwitch.state;
}

/** Test hook. */
export function _resetEngineSwitchCache(): void {
  cachedSwitch = null;
}

/**
 * Which WAYS a horse is allowed to post right now.
 *
 * Dan, 2026-09-06, on seeing the grounded hand posts live: "ANYTIME YOU
 * CREATE SOME NEW WAY FOR A HORSE TO POST, OR GIVE IT AN INSTRUCTION TO
 * 'CREATE NEW CONTENT' I NEED TO APPROVE IT FIRST."
 *
 * He was right about the posts. They were true, they passed every law test
 * written for them, and none of those tests asked whether a person would want
 * to read one:
 *
 *   "No hand, all narrative. Qh8c7d6sAd5c on 5s 4s Td 3c 6d. won 184bb"
 *
 * So each way of posting is a row in `horse_post_modes`, a new one starts
 * disabled, and turning it on is Dan's - it is data, so approving costs one
 * UPDATE and no deploy.
 *
 * FAILS CLOSED. If the table cannot be read, a mode is treated as OFF. That
 * is the opposite of every other fallback in this engine, and deliberately:
 * everywhere else a failed read must not silence a horse, but here a failed
 * read must not put an unapproved voice in front of players. Silence is
 * recoverable; a thousand accounts posting something Dan has not seen is not.
 */
const modeCache = new Map<string, { enabled: boolean; at: number }>();
const MODE_TTL_MS = 60_000;

export async function postModeEnabled(mode: string): Promise<boolean> {
  const hit = modeCache.get(mode);
  if (hit && Date.now() - hit.at < MODE_TTL_MS) return hit.enabled;
  const { data, error } = await getSupabase()
    .from('horse_post_modes')
    .select('enabled')
    .eq('mode', mode)
    .maybeSingle();
  if (error) {
    console.warn(`[fleet] post-mode read failed for ${mode}; treating as OFF:`, error.message);
    return false;
  }
  const enabled = Boolean((data as { enabled?: boolean } | null)?.enabled);
  modeCache.set(mode, { enabled, at: Date.now() });
  return enabled;
}

/**
 * Read an exact set of mode rows without collapsing an outage or missing row
 * into an intentional disable. Critical isolated routes use this authoritative
 * snapshot so their monitor can distinguish "off" from "could not read".
 */
export async function readPostModeStates<const T extends string>(
  modes: readonly T[],
): Promise<Record<T, boolean>> {
  const requested = [...new Set(modes)];
  const { data, error } = await getSupabase()
    .from('horse_post_modes')
    .select('mode, enabled')
    .in('mode', requested);
  if (error) throw new Error(`horse post modes unreadable: ${error.message}`);

  const found = new Map<string, boolean>();
  for (const row of (data ?? []) as Array<{ mode?: unknown; enabled?: unknown }>) {
    if (typeof row.mode !== 'string' || !requested.includes(row.mode as T)) continue;
    if (found.has(row.mode) || typeof row.enabled !== 'boolean') {
      throw new Error(`horse post mode ${row.mode} is malformed`);
    }
    found.set(row.mode, row.enabled);
  }
  const missing = requested.filter((mode) => !found.has(mode));
  if (missing.length) throw new Error(`horse post modes missing: ${missing.join(', ')}`);

  const observedAt = Date.now();
  for (const mode of requested) modeCache.set(mode, { enabled: found.get(mode)!, at: observedAt });
  return Object.fromEntries(requested.map((mode) => [mode, found.get(mode)!])) as Record<T, boolean>;
}

/** Test hook. */
export function _resetPostModes(): void {
  modeCache.clear();
}
