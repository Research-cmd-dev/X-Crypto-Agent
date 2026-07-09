/**
 * Backfill post-graduation outcomes for recent pump.fun launches.
 *
 * Flow (no LLM):
 *   1. Load recent graduations (Solana Tracker preferred)
 *   2. Score with launchScore at T0 features
 *   3. Pull historical prices via Birdeye at T0 / T+1h / T+6h / T+24h
 *   4. Print labels + how launchScore separates strong vs rugged
 *   5. Optionally write JSONL to fixtures/outcomes/
 *
 *   npm run backfill-outcomes
 *   npm run backfill-outcomes -- 48          # lookback hours for grads (default 36)
 *   npm run backfill-outcomes -- 48 --save
 *
 * Requires: SOLANATRACKER_API_KEY (or BITQUERY) + BIRDEYE_API_KEY
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SolanaTrackerProvider } from "@/lib/providers/solanatracker";
import { BitqueryProvider } from "@/lib/providers/bitquery";
import { PriceProvider } from "@/lib/providers/price";
import {
  collectLaunchFeaturesBatch,
  type SeedGraduation,
} from "@/lib/discovery/launch-features";
import { computeLaunchScore } from "@/lib/schema/launch-score";
import {
  computeOutcome,
  formatPct,
  scoreDiscrimination,
  type LaunchOutcome,
} from "@/lib/schema/outcomes";

const ENRICH_CAP = 25;

async function loadSeeds(sinceISO: string, limit: number): Promise<SeedGraduation[]> {
  if (process.env.SOLANATRACKER_API_KEY) {
    const st = new SolanaTrackerProvider();
    const { graduations } = await st.recentGraduations(sinceISO, limit);
    return graduations.map((g) => ({
      mint: g.mint,
      graduatedAt: g.graduatedAt,
      symbol: g.symbol,
      twitter: g.twitter,
      marketCapUsd: g.marketCapUsd,
      liquidityUsd: g.liquidityUsd,
      holders: g.holders,
      riskScore: g.riskScore,
      top10HolderPct: g.top10HolderPct,
      volume24hUsd: g.volume24hUsd,
      mintAuthority: g.mintAuthority,
      freezeAuthority: g.freezeAuthority,
    }));
  }
  if (process.env.BITQUERY_API_KEY) {
    const bq = new BitqueryProvider();
    const { migrations } = await bq.recentMigrations(sinceISO, limit);
    return (migrations ?? []).map((m: any) => ({
      mint: m.mint,
      graduatedAt: m.migratedAt,
      holders: m.holders,
      traders24h: m.traders24h,
    }));
  }
  return [];
}

async function main() {
  const args = process.argv.slice(2);
  const hours = Number(args.find((a) => /^\d+$/.test(a)) ?? 36);
  const save = args.includes("--save");

  if (!process.env.BIRDEYE_API_KEY) {
    console.error("BIRDEYE_API_KEY required for outcome price history.");
    process.exit(1);
  }
  if (!process.env.SOLANATRACKER_API_KEY && !process.env.BITQUERY_API_KEY) {
    console.error("SOLANATRACKER_API_KEY (preferred) or BITQUERY_API_KEY required.");
    process.exit(1);
  }

  // Need graduates old enough that 24h has elapsed
  const lookbackMs = hours * 3600_000;
  const minAgeMs = 25 * 3600_000; // prefer tokens ≥25h old so 24h return exists
  const since = new Date(Date.now() - lookbackMs).toISOString();
  const price = new PriceProvider();

  console.log(`\n📉 Outcome backfill — grads since ${since} (cap ${ENRICH_CAP})`);
  const seeds = (await loadSeeds(since, 80)).filter((s) => {
    if (!s.graduatedAt) return true;
    const age = Date.now() - new Date(s.graduatedAt).getTime();
    return age >= minAgeMs || hours < 24;
  });

  if (!seeds.length) {
    console.log("No graduations in window (or none old enough for 24h outcomes).");
    console.log("Tip: use a larger lookback, e.g. npm run backfill-outcomes -- 72");
    return;
  }

  console.log(`Scoring ${Math.min(ENRICH_CAP, seeds.length)} tokens + fetching Birdeye history…\n`);
  const slice = seeds.slice(0, ENRICH_CAP);
  const features = await collectLaunchFeaturesBatch(slice, 4, { skipGmgn: true });

  type Row = {
    mint: string;
    symbol: string | null;
    graduatedAt: string | null;
    /** Full T0 feature pack — required for offline re-scoring / calibrate-launches. */
    features: (typeof features)[0];
    launchScore: number;
    vetoed: boolean;
    outcome: LaunchOutcome;
    priceT0: number | null;
    sources: string[];
  };

  const rows: Row[] = [];
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    const seed = slice[i];
    const scored = computeLaunchScore(f);
    const t0ms = seed.graduatedAt ? new Date(seed.graduatedAt).getTime() : Date.now() - minAgeMs;
    const t0 = Math.floor(t0ms / 1000);

    const [p0, p1, p6, p24] = await Promise.all([
      price.priceAtUnix(f.mint, t0),
      price.priceAtUnix(f.mint, t0 + 3600),
      price.priceAtUnix(f.mint, t0 + 6 * 3600),
      price.priceAtUnix(f.mint, t0 + 24 * 3600),
    ]);

    const outcome = computeOutcome(
      { priceUsd: p0?.priceUsd ?? null, source: p0?.source },
      {
        h1: p1 ? { priceUsd: p1.priceUsd, source: p1.source } : null,
        h6: p6 ? { priceUsd: p6.priceUsd, source: p6.source } : null,
        h24: p24 ? { priceUsd: p24.priceUsd, source: p24.source } : null,
      },
    );

    rows.push({
      mint: f.mint,
      symbol: seed.symbol ?? null,
      graduatedAt: seed.graduatedAt ?? null,
      features: f,
      launchScore: scored.score,
      vetoed: scored.vetoed,
      outcome,
      priceT0: p0?.priceUsd ?? null,
      sources: f.sources ?? [],
    });

    // light pacing
    await new Promise((r) => setTimeout(r, 80));
  }

  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  console.log(
    `  ${pad("sc", 5)}${pad("1h", 9)}${pad("6h", 9)}${pad("24h", 9)}${pad("label", 8)}${pad("mint", 14)}`,
  );
  console.log(`  ${"-".repeat(70)}`);
  for (const r of rows.sort((a, b) => b.launchScore - a.launchScore)) {
    const sc = r.vetoed ? "VETO" : String(r.launchScore);
    console.log(
      `  ${pad(sc, 5)}${pad(formatPct(r.outcome.ret1h), 9)}${pad(formatPct(r.outcome.ret6h), 9)}${pad(formatPct(r.outcome.ret24h), 9)}${pad(r.outcome.label, 8)}${r.mint.slice(0, 6)}…${r.mint.slice(-4)}`,
    );
  }

  const disc = scoreDiscrimination(
    rows.map((r) => ({
      launchScore: r.vetoed ? 0 : r.launchScore,
      label: r.outcome.label,
    })),
  );
  console.log(`\nCalibration snapshot (n=${disc.n}):`);
  console.log(
    `  avg launchScore ok/strong: ${disc.highAvgScore?.toFixed(1) ?? "n/a"}`,
  );
  console.log(
    `  avg launchScore rugged:    ${disc.ruggedAvgScore?.toFixed(1) ?? "n/a"}`,
  );
  console.log(
    `  gap (want positive):       ${disc.gap != null ? disc.gap.toFixed(1) : "n/a"}`,
  );

  if (save) {
    const dir = path.resolve("fixtures/outcomes");
    mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `outcomes-${new Date().toISOString().slice(0, 13)}.jsonl`);
    writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(`\nSaved ${rows.length} rows → ${out}`);
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
