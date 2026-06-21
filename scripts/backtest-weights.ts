/**
 * Backtest the scoring weights against realized forward returns.
 *
 *   npm run backtest            # read-only: report active vs. best-found weights
 *   npm run backtest -- --write # also insert the best as an INACTIVE candidate
 *                               # weight_versions row for review
 *
 * Requires Supabase env (reads matured `outcomes` + frozen reports). Reports
 * "insufficient matured samples" until tracked tokens reach the 30-day horizon.
 */
import { loadSamples, fitness, searchWeights } from "@/lib/scoring/backtest";
import { loadActiveProfile } from "@/lib/scoring/profile";
import { supabaseServer } from "@/lib/supabase/server";

const MIN_SAMPLES = 10;

async function main() {
  const write = process.argv.includes("--write");

  const samples = await loadSamples();
  if (samples.length < MIN_SAMPLES) {
    console.log(
      `Insufficient matured samples (${samples.length}/${MIN_SAMPLES}). ` +
        `Outcomes accumulate as tracked tokens reach the 30-day horizon — ` +
        `re-run once more history has matured.`,
    );
    return;
  }

  const active = await loadActiveProfile();
  const activeFitness = fitness(samples, active.profile);

  console.log(`Samples (matured): ${samples.length}`);
  console.log(`Active profile fitness (Spearman): ${activeFitness.toFixed(4)}\n`);

  const result = searchWeights(samples, active.profile);
  console.log(
    `Best found: ${result.fitness.toFixed(4)} ` +
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
      label: `backtest ${new Date().toISOString().slice(0, 10)}`,
      profile: result.profile,
      active: false,
      source: "backtest",
      metrics: {
        fitness: result.fitness,
        baselineFitness: result.baselineFitness,
        samples: samples.length,
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
