import { task, schedules, logger } from "@trigger.dev/sdk/v3";
import { supabaseServer } from "@/lib/supabase/server";
import { getGmgnProvider, type GmgnProvider } from "@/lib/providers/gmgn";
import { migrationToCandidate, parseTwitterHandle } from "@/lib/discovery/migration";
import { analyzeCandidateTask } from "@/trigger/analyze-candidate";

/**
 * Migration funnel: poll GMGN for tokens that just graduated off the bonding
 * curve onto a DEX, link each to its X account, and queue analysis. Graduation
 * volume is small (~1–3 per 30-min poll), so dedup against existing candidates by
 * token_address is enough to pick out "new since last poll".
 */
export async function runMigrations(
  gmgn: GmgnProvider = getGmgnProvider(),
): Promise<{ scanned: number; inserted: number; merged: number }> {
  const sb = supabaseServer();
  const tokens = await gmgn.recentMigrations({ chain: "sol", limit: 50 });
  if (tokens.length === 0) return { scanned: 0, inserted: 0, merged: 0 };

  const addrs = tokens.map((t) => t.address);
  const { data: existing } = await sb
    .from("candidates")
    .select("token_address")
    .in("token_address", addrs);
  const known = new Set((existing ?? []).map((r) => r.token_address as string));
  const fresh = tokens.filter((t) => !known.has(t.address));
  if (fresh.length === 0) return { scanned: tokens.length, inserted: 0, merged: 0 };

  let merged = 0;
  const toInsert = [];
  for (const t of fresh) {
    const row = migrationToCandidate(t);
    const handle = parseTwitterHandle(t.twitter);

    // Convergence: if the X scanner already surfaced this account (same handle,
    // no token yet), attach the token to that candidate instead of duplicating.
    if (handle) {
      const { data: acct } = await sb
        .from("candidates")
        .select("id")
        .eq("handle", handle)
        .is("token_address", null)
        .limit(1)
        .maybeSingle();
      if (acct?.id) {
        await sb
          .from("candidates")
          .update({ chain: row.chain, token_address: row.token_address, status: "queued" })
          .eq("id", acct.id);
        await analyzeCandidateTask.trigger({ candidateId: acct.id as string });
        merged++;
        continue;
      }
    }
    toInsert.push(row);
  }

  let inserted = 0;
  if (toInsert.length > 0) {
    const { data: ins, error } = await sb.from("candidates").insert(toInsert).select("id");
    if (error) throw new Error(`Failed to insert migration candidates: ${error.message}`);
    const ids = (ins ?? []).map((r) => r.id as string);
    inserted = ids.length;
    if (ids.length > 0) {
      await analyzeCandidateTask.batchTrigger(ids.map((candidateId) => ({ payload: { candidateId } })));
    }
  }

  logger.info("migrations complete", { scanned: tokens.length, inserted, merged });
  return { scanned: tokens.length, inserted, merged };
}

/** Manually-triggerable migration scan (dashboard / ad-hoc). */
export const migrationsTask = task({
  id: "migrations",
  maxDuration: 600,
  run: async () => runMigrations(),
});

/** Scheduled migration scan — every 30 minutes. */
export const migrationsSchedule = schedules.task({
  id: "migrations-schedule",
  cron: "*/30 * * * *",
  run: async () => runMigrations(),
});
