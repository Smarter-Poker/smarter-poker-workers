/**
 * Supabase client — service-role, server-side only.
 * Identical pattern to World Hub's src/lib/supabaseServerClient.js
 * lazy-init to prevent module-scope env var crashes when envs haven't
 * loaded yet (e.g., during Docker boot).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error('[supabase] SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) not set');
  if (!key) throw new Error('[supabase] SUPABASE_SERVICE_ROLE_KEY not set');

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
