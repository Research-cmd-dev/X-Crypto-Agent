/**
 * Today's pump.fun migrations (graduations), enriched and ranked by launchScore
 * (on-chain-first probability heuristic — no LLM).
 *
 *   npm run migrations            # today (UTC)
 *   npm run migrations -- 48      # last 48 hours
 *   npm run migrations -- 6 --no-gmgn
 *
 * Requires SOLANATRACKER_API_KEY (preferred) or BITQUERY_API_KEY.
 * Optional: BIRDEYE_API_KEY, GMGN_API_KEY (safety/smart-money boost only).
 *
 * For a dedicated shortlist view: npm run rank-launches
 * Deep dive: npm run analyze -- <handle>
 */
import { BitqueryProvider } from "@/lib/providers/bitquery";
import { SolanaTrackerProvider } from "@/lib/providers/solanatracker";
import {
  collectLaunchFeaturesBatch,
  type SeedGraduation,
} from "@/lib/discovery/launch-features";
import { rankLaunches, selectTopKForDeepDive } from "@/lib/schema/launch-score";
import { handleFromXUrl } from "@/lib/extract";

const ENRICH_CAP = 24;

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const usd = (n: number | null) =>
  n == null
    ? "?"
    : n >= 1e6
      ? `$${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `$${(n / 1e3).toFixed(0)}k`
        : `$${n.toFixed(0)}`;
const hhmm = (iso: string | null) => (iso ? iso.slice(11, 16) : "??:??");

async function main() {
  const args = process.argv.slice(2);
  const useTracker = !!process.env.SOLANATRACKER_API_KEY;
  if (!useTracker && !process.env.BITQUERY_API_KEY) {
    console.error("Set SOLANATRACKER_API_KEY (preferred) or BITQUERY_API_KEY for migrations.");
    process.exit(1);
  }
  const hours = Number(args.find((a) => /^\d+$/.test(a)) ?? "");
  const skipGmgn = args.includes("--no-gmgn");
  const since = new Date();
  if (Number.isFinite(hours) && hours > 0) since.setTime(Date.now() - hours * 3_600_000);
  else since.setUTCHours(0, 0, 0, 0);
  const sinceISO = since.toISOString();

  console.log(
    `\n🎓 pump.fun migrations since ${sinceISO} … ranking by launchScore` +
      (useTracker ? " (Solana Tracker)" : " (Bitquery)"),
  );

  let seeds: SeedGraduation[] = [];
  let total = 0;

  if (useTracker) {
    const st = new SolanaTrackerProvider();
    const { graduations, total: t } = await st.recentGraduations(sinceISO, 60);
    total = t || graduations.length;
    seeds = graduations.map((g) => ({
      mint: g.mint,
      graduatedAt: g.graduatedAt || sinceISO,
      symbol: g.symbol,
      twitter: g.twitter,
      marketCapUsd: g.marketCapUsd,
      liquidityUsd: g.liquidityUsd,
    }));
  } else {
    const bq = new BitqueryProvider();
    const { migrations, total: t } = await bq.recentMigrations(sinceISO, 60);
    total = t;
    seeds = (migrations ?? []).map((m: { mint: string; migratedAt?: string; holders?: number; traders24h?: number; symbol?: string; twitter?: string; marketCapUsd?: number }) => ({
      mint: m.mint,
      graduatedAt: m.migratedAt,
      symbol: m.symbol ?? null,
      twitter: m.twitter ?? null,
      holders: m.holders ?? null,
      traders24h: m.traders24h ?? null,
      marketCapUsd: m.marketCapUsd ?? null,
    }));
  }

  if (seeds.length === 0) {
    console.log("No migrations found in the window.");
    return;
  }
  console.log(`${total} token(s) migrated. Enriching ${Math.min(ENRICH_CAP, seeds.length)} for launchScore…\n`);

  const features = await collectLaunchFeaturesBatch(seeds.slice(0, ENRICH_CAP), 5, {
    skipGmgn,
  });
  const ranked = rankLaunches(features);
  const deep = selectTopKForDeepDive(features);

  console.log(
    `  ${pad("sc", 5)}${pad("time", 6)}${pad("hold", 8)}${pad("mcap", 8)}${pad("liq", 8)}${pad("sm", 4)}${pad("tw", 4)}${pad("mint", 14)}reasons`,
  );
  console.log(`  ${"-".repeat(96)}`);
  for (const r of ranked) {
    const sc = r.result.vetoed ? "VETO" : String(r.result.score);
    const reasons = r.result.vetoed
      ? r.result.vetoReasons.join(",")
      : r.result.reasons.slice(0, 3).join(" · ");
    console.log(
      `  ${pad(sc, 5)}${pad(hhmm(r.graduatedAt), 6)}${pad(r.holders?.toLocaleString() ?? "?", 8)}${pad(usd(r.marketCapUsd), 8)}${pad(usd(r.liquidityUsd), 8)}${pad(r.smartMoneyCount ?? "?", 4)}${pad(r.hasTwitter ? "Y" : "-", 4)}${pad(r.mint.slice(0, 6) + "…" + r.mint.slice(-4), 14)}${reasons}`,
    );
  }

  console.log(`\n✅ Shortlist for deep analysis (${deep.length}):`);
  for (const d of deep) {
    const seed = seeds.find((s) => s.mint === d.mint);
    const twRaw = seed?.twitter;
    const tw = twRaw ? handleFromXUrl(twRaw) ?? twRaw.replace(/^@/, "") : null;
    console.log(
      `  score=${d.result.score}  ${d.mint}` +
        (tw ? `  → npm run analyze -- ${tw}` : ""),
    );
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
