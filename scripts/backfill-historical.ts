/**
 * Build a HISTORICAL backtest set from a curated project list, using CoinGecko
 * price history (the only signals that are time-travelable) + immutable account
 * age. Each entry becomes a matured `outcomes` row tagged `dataset='historical'`.
 *
 *   npm run backfill                       # reads data/historical-projects.json, writes to DB
 *   npm run backfill -- --dry-run          # fetch + print only, no DB writes
 *   npm run backfill -- path/to/list.json  # custom list path
 *
 * List format (see data/historical-projects.example.json):
 *   [{ "handle": "proj", "coingeckoId": "proj-token", "token": "PROJ",
 *      "entryDate": "2024-09-01", "horizonDays": 30 }]
 *
 * Requires network (CoinGecko, X). DB writes require Supabase env. Free-tier
 * CoinGecko limits history to ~365 days and is rate-limited — keep entry dates
 * within the last year; the script throttles to 1 request at a time.
 */
import { readFileSync } from "node:fs";
import { PriceProvider } from "@/lib/providers/price";
import { getXProvider, type XProvider } from "@/lib/providers/x";
import { mapLimit } from "@/lib/util/fetch";
import { computeScores } from "@/lib/schema/scoring";
import { forwardReturn } from "@/lib/scoring/outcome";
import { buildHistoricalReport, MEASURED_SIGNALS } from "@/lib/scoring/historical";
import { loadActiveProfile } from "@/lib/scoring/profile";
import { supabaseServer } from "@/lib/supabase/server";

interface Entry {
  handle: string;
  coingeckoId?: string;
  token?: string;
  entryDate: string; // YYYY-MM-DD
  horizonDays?: number;
}

const DEFAULT_HORIZON = 30;
const MS_PER_DAY = 86_400_000;

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const path = args.find((a) => !a.startsWith("-")) ?? "data/historical-projects.json";
  return { dryRun, path };
}

async function main() {
  const { dryRun, path } = parseArgs();
  const entries = JSON.parse(readFileSync(path, "utf8")) as Entry[];
  console.log(`Loaded ${entries.length} project(s) from ${path}${dryRun ? " (dry run)" : ""}.`);

  const price = new PriceProvider();
  // X only supplies the immutable created_at (age signal); make it best-effort so
  // a dry run works with just CoinGecko (no X_API_BEARER_TOKEN / Supabase env).
  let x: XProvider | null = null;
  try {
    x = getXProvider();
  } catch {
    console.warn("X provider unavailable (no X_API_BEARER_TOKEN) — account age will be neutral.");
  }
  const active = dryRun ? { id: null } : await loadActiveProfile();
  const sb = dryRun ? null : supabaseServer();

  let written = 0;
  let skipped = 0;

  // Concurrency 1 to stay under free-tier CoinGecko rate limits.
  await mapLimit(entries, 1, async (entry) => {
    const entryDate = new Date(`${entry.entryDate}T00:00:00Z`);
    if (Number.isNaN(entryDate.getTime())) {
      console.warn(`  skip ${entry.handle}: invalid entryDate "${entry.entryDate}"`);
      skipped++;
      return;
    }
    const horizon = entry.horizonDays ?? DEFAULT_HORIZON;
    const outcomeDate = new Date(entryDate.getTime() + horizon * MS_PER_DAY);
    if (outcomeDate.getTime() > Date.now()) {
      console.warn(`  skip ${entry.handle}: entryDate + ${horizon}d is in the future (not matured)`);
      skipped++;
      return;
    }

    const coinId = entry.coingeckoId ?? (await price.coinIdFor(entry.token ?? entry.handle));
    if (!coinId) {
      console.warn(`  skip ${entry.handle}: could not resolve a CoinGecko coin id`);
      skipped++;
      return;
    }

    const baseline = await price.historyOn(coinId, entryDate);
    const outcome = await price.historyOn(coinId, outcomeDate);
    if (!baseline) {
      console.warn(`  skip ${entry.handle}: no price history for '${coinId}' on ${entry.entryDate}`);
      skipped++;
      return;
    }
    const ret = forwardReturn(
      baseline.priceUsd,
      baseline.marketCapUsd,
      outcome?.priceUsd ?? null,
      outcome?.marketCapUsd ?? null,
    );
    if (ret == null) {
      console.warn(`  skip ${entry.handle}: could not compute forward return`);
      skipped++;
      return;
    }

    const xUser = x ? await x.getUserByHandle(entry.handle).catch(() => null) : null;
    const token = entry.token ?? coinId.toUpperCase();
    const report = buildHistoricalReport(
      { handle: entry.handle, token, createdAt: xUser?.createdAt ?? null },
      baseline,
    );
    const scores = computeScores(report, undefined);

    console.log(
      `  ${entry.handle.padEnd(20)} ${coinId.padEnd(18)} ` +
        `base $${baseline.priceUsd ?? "?"} → ${horizon}d ` +
        `ret ${(ret * 100).toFixed(1)}%  earliness=${scores.earliness} price=${scores.price}`,
    );

    if (dryRun || !sb) {
      return;
    }

    // Idempotent: deterministic synthetic id keeps historical candidates separate
    // from live ones; deleting the candidate's reports cascades to old scores/outcomes.
    const xUserId = `hist:${entry.handle.toLowerCase()}:${entry.entryDate}`;
    const { data: cand, error: candErr } = await sb
      .from("candidates")
      .upsert(
        {
          x_user_id: xUserId,
          handle: entry.handle,
          display_name: xUser?.name ?? null,
          discovery_note: "historical backfill",
          status: "analyzed",
          discovered_at: entryDate.toISOString(),
          analyzed_at: entryDate.toISOString(),
        },
        { onConflict: "x_user_id" },
      )
      .select("id")
      .single();
    if (candErr || !cand) {
      console.warn(`  skip ${entry.handle}: candidate upsert failed: ${candErr?.message}`);
      skipped++;
      return;
    }
    const candidateId = cand.id as string;
    await sb.from("analysis_reports").delete().eq("candidate_id", candidateId);

    const { data: rep, error: repErr } = await sb
      .from("analysis_reports")
      .insert({
        candidate_id: candidateId,
        model: "historical-backfill",
        payload: report,
        created_at: entryDate.toISOString(),
      })
      .select("id")
      .single();
    if (repErr || !rep) {
      console.warn(`  skip ${entry.handle}: report insert failed: ${repErr?.message}`);
      skipped++;
      return;
    }
    const reportId = rep.id as string;

    await sb.from("scores").insert({
      candidate_id: candidateId,
      report_id: reportId,
      smart_money: scores.smartMoney,
      earliness: scores.earliness,
      profile: scores.profile,
      website: scores.website,
      github: scores.github,
      engagement: scores.engagement,
      technical_depth: scores.technicalDepth,
      price: scores.price,
      overall: scores.overall,
      verdict: scores.verdict,
      weight_version_id: active.id,
    });

    await sb.from("outcomes").insert({
      candidate_id: candidateId,
      report_id: reportId,
      token_ref: token,
      baseline_price_usd: baseline.priceUsd,
      baseline_mcap_usd: baseline.marketCapUsd,
      baseline_at: entryDate.toISOString(),
      last_price_usd: outcome?.priceUsd ?? null,
      last_mcap_usd: outcome?.marketCapUsd ?? null,
      last_checked_at: outcomeDate.toISOString(),
      forward_return: ret,
      horizon_days: horizon,
      matured: true,
      dataset: "historical",
      measured_signals: MEASURED_SIGNALS,
    });
    written++;
  });

  console.log(
    dryRun
      ? `\nDry run complete. ${entries.length - skipped} would be written, ${skipped} skipped.`
      : `\nDone. Wrote ${written} historical sample(s), skipped ${skipped}.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
