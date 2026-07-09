import { task, schedules, logger } from "@trigger.dev/sdk/v3";
import { supabaseServer } from "@/lib/supabase/server";
import { getXProvider, type XProvider } from "@/lib/providers/x";
import { BitqueryProvider } from "@/lib/providers/bitquery";
import { SolanaTrackerProvider } from "@/lib/providers/solanatracker";
import type { SignalSourceRow } from "@/lib/supabase/types";
import { analyzeCandidateTask } from "@/trigger/analyze-candidate";
import { scanSignalSources } from "@/lib/discovery/scan";
import { handleFromXUrl } from "@/lib/extract";
import {
  collectLaunchFeaturesBatch,
  type SeedGraduation,
} from "@/lib/discovery/launch-features";
import {
  selectTopKForDeepDive,
  DEFAULT_LAUNCH_SCORE,
} from "@/lib/schema/launch-score";

/** Cap how many migrations we enrich per run (feature pack, no LLM). */
const MIGRATION_ENRICH_CAP = 30;
/** Soft floor: skip dust if mcap and liq both present and both tiny. */
const MIN_MCAP_USD = 5_000;
const MIN_LIQ_USD = 1_000;

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

  // Dedupe against existing candidates by x_user_id (token dedupe handled in migration path).
  const ids = found.map((c) => c.xUserId).filter(Boolean) as string[];
  const { data: existing } = ids.length > 0
    ? await sb.from("candidates").select("x_user_id").in("x_user_id", ids)
    : { data: [] };
  const existingIds = new Set((existing ?? []).map((r) => r.x_user_id as string));

  const fresh = found.filter((c) => !c.xUserId || !existingIds.has(c.xUserId));
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

/** Scheduled X discovery — every 30 minutes (configurable toward the dual 30min goal). */
export const discoverySchedule = schedules.task({
  id: "discovery-schedule",
  cron: "*/30 * * * *",
  run: async () => runDiscovery(),
});

// ---------------------- Migration (pump.fun) discovery ----------------------

interface MigrationHit {
  mint: string;
  migratedAt?: string;
  symbol?: string | null;
  twitter?: string | null;
  marketCapUsd?: number;
  liquidityUsd?: number;
  holders?: number | null;
  traders24h?: number | null;
  source: "solanatracker" | "bitquery";
}

/**
 * Discover recent pump.fun migrations, score them with launchScore (no LLM),
 * and only insert + deep-analyze the top-K survivors.
 */
export async function runMigrationDiscovery(hours = 1): Promise<{ scanned: number; inserted: number }> {
  const sb = supabaseServer();
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const hits = await loadRecentMigrations(since, 50);
  if (hits.length === 0) return { scanned: 0, inserted: 0 };

  // Cheap market filter first (ST list already has mcap/liq when available).
  const marketOk = hits.filter((h) => {
    if (!h.mint) return false;
    const mcap = h.marketCapUsd;
    const liq = h.liquidityUsd;
    if (mcap != null && liq != null && mcap < MIN_MCAP_USD && liq < MIN_LIQ_USD) return false;
    return true;
  });

  const seeds: SeedGraduation[] = marketOk.slice(0, MIGRATION_ENRICH_CAP).map((h) => ({
    mint: h.mint,
    graduatedAt: h.migratedAt,
    symbol: h.symbol,
    twitter: h.twitter,
    marketCapUsd: h.marketCapUsd,
    liquidityUsd: h.liquidityUsd,
    holders: h.holders,
    traders24h: h.traders24h,
  }));

  // Feature pack: ST/price primary; GMGN optional (skipped if no key).
  const features = await collectLaunchFeaturesBatch(seeds, 5);
  const shortlist = selectTopKForDeepDive(features, DEFAULT_LAUNCH_SCORE);

  logger.info("migration launchScore funnel", {
    scanned: hits.length,
    marketOk: marketOk.length,
    enriched: features.length,
    shortlist: shortlist.length,
    topScores: shortlist.map((s) => ({ mint: s.mint.slice(0, 8), score: s.result.score })),
    topK: DEFAULT_LAUNCH_SCORE.topK,
    minScore: DEFAULT_LAUNCH_SCORE.minScoreForDeepDive,
  });

  if (shortlist.length === 0) {
    return { scanned: hits.length, inserted: 0 };
  }

  const hitByMint = new Map(hits.map((h) => [h.mint, h]));
  const candidatesToInsert: Array<Record<string, unknown>> = [];

  for (const m of shortlist) {
    const hit = hitByMint.get(m.mint);
    const twRaw = hit?.twitter?.trim() || null;
    const fromUrl = twRaw ? handleFromXUrl(twRaw) : null;
    const stripped = twRaw ? twRaw.replace(/^@/, "").replace(/.*\//, "") || null : null;
    const handleFromTw = fromUrl ?? stripped;
    const handle =
      handleFromTw ?? `token:${m.mint.slice(0, 6)}…${m.mint.slice(-4)}`;

    const note = [
      `launchScore=${m.result.score}`,
      `pump.fun via ${hit?.source ?? "unknown"}`,
      hit?.migratedAt ? `at ${hit.migratedAt}` : null,
      m.result.reasons.slice(0, 4).join("; ") || null,
    ]
      .filter(Boolean)
      .join(" | ");

    candidatesToInsert.push({
      x_user_id: null,
      handle,
      display_name: hit?.symbol ?? null,
      token_address: m.mint,
      chain: "solana",
      source_id: null,
      discovery_note: note,
      status: "queued",
    });
  }

  const mints = candidatesToInsert.map((c) => c.token_address as string).filter(Boolean);
  const { data: existingTokens } = mints.length
    ? await sb.from("candidates").select("token_address").in("token_address", mints)
    : { data: [] };
  const seenTokens = new Set(
    (existingTokens ?? []).map((r: { token_address: string }) => r.token_address),
  );

  const fresh = candidatesToInsert.filter(
    (c) => !c.token_address || !seenTokens.has(c.token_address as string),
  );
  if (fresh.length === 0) return { scanned: hits.length, inserted: 0 };

  const { data: inserted, error: insErr } = await sb
    .from("candidates")
    .insert(fresh)
    .select("id");
  if (insErr) throw new Error(`Failed to insert migration candidates: ${insErr.message}`);

  const newIds = (inserted ?? []).map((r: { id: string }) => r.id);
  if (newIds.length > 0) {
    await analyzeCandidateTask.batchTrigger(
      newIds.map((candidateId) => ({ payload: { candidateId } })),
    );
  }

  logger.info("migration discovery complete", {
    scanned: hits.length,
    shortlist: shortlist.length,
    inserted: newIds.length,
    source: hits[0]?.source,
  });
  return { scanned: hits.length, inserted: newIds.length };
}

/** Load migrations: Solana Tracker first, Bitquery fallback. */
async function loadRecentMigrations(sinceISO: string, limit: number): Promise<MigrationHit[]> {
  if (process.env.SOLANATRACKER_API_KEY) {
    const st = new SolanaTrackerProvider();
    const { graduations } = await st.recentGraduations(sinceISO, limit).catch(() => ({ graduations: [] }));
    if (graduations.length > 0) {
      return graduations.map((g) => ({
        mint: g.mint,
        migratedAt: g.graduatedAt,
        symbol: g.symbol,
        twitter: g.twitter,
        marketCapUsd: g.marketCapUsd,
        liquidityUsd: g.liquidityUsd,
        source: "solanatracker" as const,
      }));
    }
  }

  if (process.env.BITQUERY_API_KEY) {
    const bq = new BitqueryProvider();
    const { migrations } = await bq.recentMigrations(sinceISO, limit).catch(() => ({ migrations: [] as any[] }));
    return (migrations ?? []).map((m: any) => ({
      mint: m.mint,
      migratedAt: m.migratedAt,
      symbol: m.symbol ?? null,
      twitter: m.twitter ?? null,
      holders: m.holders ?? null,
      traders24h: m.traders24h ?? null,
      marketCapUsd: m.marketCapUsd,
      liquidityUsd: m.liquidityUsd,
      source: "bitquery" as const,
    }));
  }

  logger.warn("migration discovery: no SOLANATRACKER_API_KEY or BITQUERY_API_KEY");
  return [];
}

/** Manually triggerable migration discovery (useful for testing). */
export const migrationDiscoveryTask = task({
  id: "migration-discovery",
  maxDuration: 300,
  run: async ({ hours = 2 }: { hours?: number } = {}) => runMigrationDiscovery(hours),
});

/** Scheduled pump.fun migration scan — every 30 minutes (aligns with goal of frequent migration checks). */
export const migrationSchedule = schedules.task({
  id: "migration-schedule",
  cron: "*/30 * * * *",
  run: async () => runMigrationDiscovery(1),
});
