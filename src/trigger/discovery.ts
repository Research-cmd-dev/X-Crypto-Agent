import { task, schedules, logger } from "@trigger.dev/sdk/v3";
import { supabaseServer } from "@/lib/supabase/server";
import { getXProvider, type XProvider } from "@/lib/providers/x";
import type { SignalSourceRow } from "@/lib/supabase/types";
import { analyzeCandidateTask } from "@/trigger/analyze-candidate";
import { scanSignalSources } from "@/lib/discovery/scan";

/**
 * Core discovery routine: scan all active signal sources, dedupe against
 * existing candidates, insert new ones, and fan out analysis jobs.
 */
export async function runDiscovery(x: XProvider = getXProvider()): Promise<{
  scanned: number;
  inserted: number;
}> {
  const sb = supabaseServer();

  const { data: sources, error } = await sb
    .from("signal_sources")
    .select("*")
    .eq("active", true);
  if (error) throw new Error(`Failed to load signal_sources: ${error.message}`);

  const found = await scanSignalSources(
    x,
    ((sources ?? []) as SignalSourceRow[]).map((s) => ({ id: s.id, kind: s.kind, value: s.value })),
    { log: (msg, meta) => logger.warn(msg, meta ?? {}) },
  );

  if (found.length === 0) return { scanned: 0, inserted: 0 };

  // Dedupe against existing candidates by x_user_id.
  const ids = found.map((c) => c.xUserId);
  const { data: existing } = await sb
    .from("candidates")
    .select("x_user_id")
    .in("x_user_id", ids);
  const existingIds = new Set((existing ?? []).map((r) => r.x_user_id as string));

  const fresh = found.filter((c) => !existingIds.has(c.xUserId));
  if (fresh.length === 0) return { scanned: found.length, inserted: 0 };

  const { data: inserted, error: insErr } = await sb
    .from("candidates")
    .insert(
      fresh.map((c) => ({
        x_user_id: c.xUserId,
        handle: c.handle,
        display_name: c.displayName,
        source_id: c.sourceId,
        discovery_note: c.note,
        status: "queued",
      })),
    )
    .select("id");
  if (insErr) throw new Error(`Failed to insert candidates: ${insErr.message}`);

  const newIds = (inserted ?? []).map((r) => r.id as string);
  if (newIds.length > 0) {
    await analyzeCandidateTask.batchTrigger(
      newIds.map((candidateId) => ({ payload: { candidateId } })),
    );
  }

  logger.info("discovery complete", { scanned: found.length, inserted: newIds.length });
  return { scanned: found.length, inserted: newIds.length };
}

/** Manually-triggerable discovery task (used by the dashboard API route). */
export const discoveryTask = task({
  id: "discovery",
  maxDuration: 600,
  run: async () => runDiscovery(),
});

/** Scheduled discovery — every 6 hours by default. */
export const discoverySchedule = schedules.task({
  id: "discovery-schedule",
  cron: "0 */6 * * *",
  run: async () => runDiscovery(),
});
