/**
 * Rank recent pump.fun graduations by launchScore (no LLM).
 *
 *   npm run rank-launches              # last 6 hours, enrich up to 40
 *   npm run rank-launches -- 12        # last 12 hours
 *   npm run rank-launches -- 6 --no-gmgn
 *
 * Primary data: Solana Tracker (+ Birdeye/DexScreener when keyed).
 * Optional: GMGN for risk/smart-money (pass --no-gmgn to skip; score still works).
 *
 * Deep-dive survivors:
 *   npm run analyze -- <twitter-handle>
 */
import { SolanaTrackerProvider } from "@/lib/providers/solanatracker";
import { BitqueryProvider } from "@/lib/providers/bitquery";
import {
  collectLaunchFeaturesBatch,
  type SeedGraduation,
} from "@/lib/discovery/launch-features";
import {
  rankLaunches,
  selectTopKForDeepDive,
  DEFAULT_LAUNCH_SCORE,
} from "@/lib/schema/launch-score";
import { handleFromXUrl } from "@/lib/extract";

const ENRICH_CAP = 40;

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const usd = (n: number | null) =>
  n == null
    ? "?"
    : n >= 1e6
      ? `$${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `$${(n / 1e3).toFixed(0)}k`
        : `$${n.toFixed(0)}`;

async function loadSeeds(sinceISO: string, limit: number): Promise<SeedGraduation[]> {
  if (process.env.SOLANATRACKER_API_KEY) {
    const st = new SolanaTrackerProvider();
    const { graduations } = await st.recentGraduations(sinceISO, limit);
    if (graduations.length) {
      return graduations.map((g) => ({
        mint: g.mint,
        graduatedAt: g.graduatedAt,
        symbol: g.symbol,
        twitter: g.twitter,
        marketCapUsd: g.marketCapUsd,
        liquidityUsd: g.liquidityUsd,
      }));
    }
  }
  if (process.env.BITQUERY_API_KEY) {
    const bq = new BitqueryProvider();
    const { migrations } = await bq.recentMigrations(sinceISO, limit);
    return (migrations ?? []).map((m: { mint: string; migratedAt?: string; holders?: number; traders24h?: number }) => ({
      mint: m.mint,
      graduatedAt: m.migratedAt,
      holders: m.holders ?? null,
      traders24h: m.traders24h ?? null,
    }));
  }
  return [];
}

async function main() {
  const args = process.argv.slice(2);
  const hoursArg = args.find((a) => /^\d+$/.test(a));
  const hours = hoursArg ? Number(hoursArg) : 6;
  const skipGmgn = args.includes("--no-gmgn");

  if (!process.env.SOLANATRACKER_API_KEY && !process.env.BITQUERY_API_KEY) {
    console.error("Set SOLANATRACKER_API_KEY (preferred) or BITQUERY_API_KEY.");
    process.exit(1);
  }

  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  console.log(`\n🎯 Ranking pump.fun launches since ${since}`);
  console.log(
    `   enrich ≤${ENRICH_CAP} · topK=${DEFAULT_LAUNCH_SCORE.topK} · minScore=${DEFAULT_LAUNCH_SCORE.minScoreForDeepDive}` +
      (skipGmgn ? " · GMGN off" : process.env.GMGN_API_KEY ? " · GMGN on (optional)" : " · GMGN key absent"),
  );

  const seeds = await loadSeeds(since, 80);
  if (!seeds.length) {
    console.log("No graduations found.");
    return;
  }
  console.log(`Found ${seeds.length} graduations. Collecting features for ${Math.min(ENRICH_CAP, seeds.length)}…\n`);

  const features = await collectLaunchFeaturesBatch(
    seeds.slice(0, ENRICH_CAP),
    5,
    { skipGmgn },
  );
  const ranked = rankLaunches(features);
  const deep = selectTopKForDeepDive(features);

  console.log(
    `  ${pad("#", 4)}${pad("score", 7)}${pad("symbol/mint", 14)}${pad("hold", 8)}${pad("liq", 8)}${pad("sm", 5)}${pad("risk", 6)}${pad("tw", 4)}notes`,
  );
  console.log(`  ${"-".repeat(100)}`);

  ranked.forEach((r, i) => {
    const short = `${r.mint.slice(0, 4)}…${r.mint.slice(-4)}`;
    const flag = r.result.vetoed ? "VETO" : String(r.result.score);
    const notes = r.result.vetoed
      ? r.result.vetoReasons.join(",")
      : r.result.reasons.slice(0, 4).join(" · ");
    console.log(
      `  ${pad(i + 1, 4)}${pad(flag, 7)}${pad(short, 14)}${pad(r.holders?.toLocaleString() ?? "?", 8)}${pad(usd(r.liquidityUsd), 8)}${pad(r.smartMoneyCount ?? "?", 5)}${pad(r.riskScore ?? "?", 6)}${pad(r.hasTwitter ? "Y" : "-", 4)}${notes}`,
    );
  });

  console.log(`\n✅ Deep-dive shortlist (top ${deep.length}):`);
  if (!deep.length) {
    console.log("  (none passed minScore / topK gate)");
  } else {
    for (const d of deep) {
      const seed = seeds.find((s) => s.mint === d.mint);
      const tw = seed?.twitter
        ? handleFromXUrl(seed.twitter) ?? seed.twitter.replace(/^@/, "")
        : null;
      console.log(
        `  · score=${d.result.score}  ${d.mint}` +
          (tw ? `  → npm run analyze -- ${tw}` : "  (no twitter — token-first only)"),
      );
    }
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
