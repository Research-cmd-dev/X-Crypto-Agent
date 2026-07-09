/**
 * Offline calibration of launchScore against labeled outcomes.
 *
 *   npm run calibrate-launches
 *   npm run calibrate-launches -- --k 15
 *   npm run calibrate-launches -- --write
 *   npm run calibrate-launches -- --step 0.2
 *
 * Loads fixtures/outcomes/*.jsonl (from backfill-outcomes --save).
 * If none contain features, falls back to synthetic corpus (no API keys).
 *
 * Does NOT auto-change production DEFAULT_LAUNCH_SCORE — prints + optional
 * best-config.json for human review after real data exists.
 */
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
} from "node:fs";
import path from "node:path";
import {
  evaluateConfig,
  gridSearchWeights,
  makeSyntheticLabeledLaunches,
  parseLabeledLine,
  type LabeledLaunch,
  type CalibrateMetrics,
} from "@/lib/schema/launch-calibrate";
import { DEFAULT_LAUNCH_SCORE } from "@/lib/schema/launch-score";

const OUT_DIR = path.resolve("fixtures/outcomes");

function listJsonl(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith("best-config")) continue;
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function loadLabeled(): { rows: LabeledLaunch[]; source: string } {
  const files = listJsonl(OUT_DIR);
  const rows: LabeledLaunch[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = parseLabeledLine(JSON.parse(line));
        if (parsed) rows.push(parsed);
      } catch {
        /* skip bad line */
      }
    }
  }
  if (rows.length >= 10) {
    return { rows, source: `${rows.length} rows from ${files.length} jsonl file(s)` };
  }
  const synth = makeSyntheticLabeledLaunches(80, 42);
  return {
    rows: synth,
    source:
      rows.length > 0
        ? `only ${rows.length} real rows with features — using synthetic(80) (need full features in JSONL)`
        : "synthetic(80) — run backfill-outcomes --save when keys are ready",
  };
}

function fmt(m: CalibrateMetrics): string {
  const pct = (x: number | null) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  const n = (x: number | null, d = 2) => (x == null ? "n/a" : x.toFixed(d));
  return [
    `n=${m.n} success=${m.nSuccess} base=${pct(m.baseSuccessRate)}`,
    `precision@${m.k}=${pct(m.precisionAtK)}`,
    `lift@topDecile=${n(m.liftTopDecile)} (top rate ${pct(m.topDecileSuccessRate)})`,
    `gap=${n(m.gap, 1)}`,
    `rankCorr=${n(m.rankCorr)}`,
  ].join("\n    ");
}

function main() {
  const args = process.argv.slice(2);
  const k = Number(args.find((a, i) => args[i - 1] === "--k") ?? 10) || 10;
  const step = Number(args.find((a, i) => args[i - 1] === "--step") ?? 0.15) || 0.15;
  const write = args.includes("--write");

  console.log("\n🎛️  launchScore calibration (offline)\n");
  const { rows, source } = loadLabeled();
  console.log(`Data: ${source}\n`);

  const { baseline, bestCfg, bestMetrics, tried } = gridSearchWeights(rows, { k, step });

  console.log("Baseline (DEFAULT_LAUNCH_SCORE):");
  console.log(`    ${fmt(baseline)}`);
  console.log("\nBest grid config:");
  console.log(`    ${fmt(bestMetrics)}`);
  console.log(`    tried ${tried} weight mixes (step=${step})`);
  console.log("\nRecommended weights (normalized):");
  const w = bestCfg.weights;
  console.log(
    `    traction=${w.traction.toFixed(3)}  safety=${w.safety.toFixed(3)}  smartMoney=${w.smartMoney.toFixed(3)}  market=${w.market.toFixed(3)}  social=${w.social.toFixed(3)}`,
  );
  console.log(
    `    vetoTop10Pct=${bestCfg.vetoTop10Pct}  vetoRiskScore=${bestCfg.vetoRiskScore}  minScore=${bestCfg.minScoreForDeepDive}  topK=${bestCfg.topK}`,
  );

  const improved =
    (bestMetrics.liftTopDecile ?? 0) > (baseline.liftTopDecile ?? 0) + 0.01 ||
    (bestMetrics.precisionAtK ?? 0) > (baseline.precisionAtK ?? 0) + 0.01 ||
    (bestMetrics.gap ?? 0) > (baseline.gap ?? 0) + 1;

  if (improved) {
    console.log("\n✅ Grid search improved over baseline on this corpus.");
  } else {
    console.log("\n➡️  No meaningful improvement — defaults are fine for this corpus.");
  }

  console.log(`
Next steps:
  • Real data:  npm run backfill-outcomes -- 72 --save  (needs ST + Birdeye)
  • Re-run:     npm run calibrate-launches
  • Apply:      review fixtures/outcomes/best-config.json then update DEFAULT_LAUNCH_SCORE
`);

  if (write) {
    mkdirSync(OUT_DIR, { recursive: true });
    const out = path.join(OUT_DIR, "best-config.json");
    writeFileSync(
      out,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          source,
          baseline,
          bestMetrics,
          config: bestCfg,
          note: "Do not auto-merge synthetic-only results into production defaults.",
        },
        null,
        2,
      ),
    );
    console.log(`Wrote ${out}\n`);
  }
}

main();
