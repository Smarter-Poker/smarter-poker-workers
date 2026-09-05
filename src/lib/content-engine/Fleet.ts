/**
 * Fleet: the whole roster, and the switch that stops it.
 *
 * loadFleet() pages through content_authors so that no `.limit(100)` (or the
 * PostgREST default page of 1,000, which is exactly the fleet size today and
 * one horse from being a silent truncation) decides who exists.
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
  return out;
}

let cachedSwitch: { value: boolean; at: number } | null = null;
const SWITCH_TTL_MS = 30_000;

export async function engineEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedSwitch && now - cachedSwitch.at < SWITCH_TTL_MS) return cachedSwitch.value;
  const { data, error } = await getSupabase()
    .from('content_settings')
    .select('engine_enabled')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  // A missing row or a failed read means ON: the switch exists to stop the
  // fleet on purpose, never to stop it by accident.
  const value = error || !data ? true : (data as { engine_enabled: boolean | null }).engine_enabled !== false;
  cachedSwitch = { value, at: now };
  return value;
}

/** Test hook. */
export function _resetEngineSwitchCache(): void {
  cachedSwitch = null;
}
