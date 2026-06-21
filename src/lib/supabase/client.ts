import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { publicEnv } from "@/lib/env";

/**
 * Browser-side Supabase client using the anon key. Safe for client components.
 * The dashboard primarily reads through server components / API routes, but
 * this is available for client-side reads if needed.
 */
let cached: SupabaseClient | null = null;

export function supabaseBrowser(): SupabaseClient {
  if (cached) return cached;
  cached = createClient(publicEnv.SUPABASE_URL, publicEnv.SUPABASE_ANON_KEY, {
    auth: { persistSession: true },
  });
  return cached;
}
