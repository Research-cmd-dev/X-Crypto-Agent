import { supabaseServer } from "@/lib/supabase/server";
import {
  DEFAULT_PROFILE,
  scoringProfileSchema,
  type ScoringProfile,
} from "@/lib/schema/scoring";

export interface ActiveProfile {
  /** weight_versions.id of the active profile, or null when falling back to the built-in default. */
  id: string | null;
  profile: ScoringProfile;
}

/**
 * Load the active scoring profile from `weight_versions`. FAILS OPEN — if no
 * version is active, the row is invalid, or Supabase is unavailable (e.g. a mock
 * run), it returns the built-in {@link DEFAULT_PROFILE}, so scoring never breaks.
 */
export async function loadActiveProfile(): Promise<ActiveProfile> {
  try {
    const sb = supabaseServer();
    const { data } = await sb
      .from("weight_versions")
      .select("id, profile")
      .eq("active", true)
      .maybeSingle();
    if (data?.profile) {
      const parsed = scoringProfileSchema.safeParse(data.profile);
      if (parsed.success) return { id: data.id as string, profile: parsed.data };
    }
  } catch {
    // fall through to the default profile
  }
  return { id: null, profile: DEFAULT_PROFILE };
}

/**
 * Load a specific profile by id (used to reconstruct exactly how a stored score
 * was computed). Falls back to {@link DEFAULT_PROFILE} on any miss/error.
 */
export async function loadProfileById(id: string | null): Promise<ScoringProfile> {
  if (!id) return DEFAULT_PROFILE;
  try {
    const sb = supabaseServer();
    const { data } = await sb
      .from("weight_versions")
      .select("profile")
      .eq("id", id)
      .maybeSingle();
    const parsed = scoringProfileSchema.safeParse(data?.profile);
    if (parsed.success) return parsed.data;
  } catch {
    // fall through to the default profile
  }
  return DEFAULT_PROFILE;
}
