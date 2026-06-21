/**
 * Backtest the scoring weights against realized forward returns.
 *
 *   npm run backtest                 # full model, live forward-return samples
 *   npm run backtest -- --historical # price/fundamentals historical samples
 *   npm run backtest -- --write      # also save the best as an INACTIVE candidate
 *                                    # weight_versions row for review
 *
 * Requires Supabase env. Reports "insufficient matured samples" until enough
 * outcomes exist (live: tokens reaching the 30-day horizon; historical: rows
 * created by `npm run backfill`).
 */
import {
  loadSamples,
  fitness,
  searchWeights,
  signalQualityReport,
} from "@/lib/scoring/backtest";
import { MEASURED_SIGNALS } from "@/lib/scoring/historical";
import { loadActiveProfile } from "@/lib/scoring/profile";
import { supabaseServer } from "@/lib/supabase/server";

const MIN_SAMPLES = 10;

async function main() {
  const write = process.argv.includes("--write");
  const historical = process.argv.includes("--historical");
  const dataset = historical ? "historical" : "live";

  const samples = await loadSamples({ dataset });
  if (samples.length < MIN_SAMPLES) {
    console.log(
      `Insufficient matured ${dataset} samples (${samples.length}/${MIN_SAMPLES}). ` +
        (historical
          ? `Build a historical set with: npm run backfill`
          : `Outcomes accumulate as tracked tokens reach the 30-day horizon — re-run later.`),
    );
    return;
  }

  const active = await loadActiveProfile();
  console.log(`Dataset: ${dataset}  ·  samples (matured): ${samples.length}`);
  console.log(`Active profile fitness (Spearman): ${fitness(samples, active.profile).toFixed(4)}`);

  if (historical) {
    console.log("\nPer-signal predictive power (Spearman of sub-score vs. forward return):");
    for (const s of signalQualityReport(samples, active.profile)) {
      const measured = (MEASURED_SIGNALS as readonly string[]).includes(s.key);
      console.log(
        `  ${s.key.padEnd(16)} ${s.correlation >= 0 ? " " : ""}${s.correlation.toFixed(4)}` +
          (measured ? "" : "   (not measured in this set — ignore)"),
      );
    }
    console.log(
      `\nNote: only ${MEASURED_SIGNALS.join(", ")} are measured historically; ` +
        `tuning is restricted to them so smart money/engagement weights are preserved.`,
    );
  }

  const result = searchWeights(samples, active.profile, {
    tunableKeys: historical ? MEASURED_SIGNALS : undefined,
  });
  console.log(
    `\nBest found: ${result.fitness.toFixed(4)} ` +
      `(baseline ${result.baselineFitness.toFixed(4)}, +${(
        result.fitness - result.baselineFitness
      ).toFixed(4)})`,
  );
  console.log("Proposed weights:");
  for (const [k, v] of Object.entries(result.profile.weights).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(16)} ${(v * 100).toFixed(1)}%`);
  }

  if (write && result.fitness > result.baselineFitness) {
    const sb = supabaseServer();
    const { error } = await sb.from("weight_versions").insert({
      label: `backtest ${dataset} ${new Date().toISOString().slice(0, 10)}`,
      profile: result.profile,
      active: false,
      source: "backtest",
      metrics: {
        dataset,
        fitness: result.fitness,
        baselineFitness: result.baselineFitness,
        samples: samples.length,
        tunable: historical ? MEASURED_SIGNALS : "all",
      },
    });
    if (error) throw new Error(error.message);
    console.log("\nWrote inactive candidate weight_versions row for review.");
  } else if (write) {
    console.log("\nNo improvement over the active profile — nothing written.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
