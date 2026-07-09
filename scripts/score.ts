/**
 * Fast scoring loop — re-score cached analysis reports with NO LLM/API calls.
 * The expensive part (research + synthesis) is cached once via
 * `npm run analyze -- <handle> --save`; this runs the deterministic scorer over
 * every cached report in milliseconds, so you can iterate on weights/penalties.
 *
 *   npm run score                          # score all cached reports (defaults)
 *   RF_HIGH=0 RF_CAP=20 npm run score      # sweep variables instantly, no edits
 *   W_GITHUB=0.3 W_PROFILE=0.15 npm run score
 *
 * Env overrides (any subset; unset = default):
 *   weights    W_PROFILE W_WEBSITE W_GITHUB W_ENGAGEMENT W_TECH W_PRICE
 *   penalties  RF_HIGH RF_MED RF_LOW   decay RF_DECAY   cap RF_CAP
 *   verdict    V_HIGH V_MONITOR
 *
 * Reports live in fixtures/reports/*.json (real ones from --save, plus the
 * synthetic anchors from `npm run seed:fixtures`). This re-scores each report's
 * existing flags — changing the structural-flag *rules* needs a fresh analyze.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { AnalysisReport } from "@/lib/schema/analysis";
import {
  computeScores,
  redFlagPenalty,
  DEFAULT_SCORING,
  type ScoringConfig,
} from "@/lib/schema/scoring";
import { makeReport } from "@/lib/schema/fixtures";

const DIR = path.resolve("fixtures/reports");

function num(key: string, d: number): number {
  const v = process.env[key];
  return v != null && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : d;
}

function configFromEnv(): { cfg: ScoringConfig; overrides: string[] } {
  const b = DEFAULT_SCORING;
  const overrides: string[] = [];
  const t = (k: string, d: number) => {
    const v = num(k, d);
    if (v !== d) overrides.push(`${k}=${v}`);
    return v;
  };
  const cfg: ScoringConfig = {
    weights: {
      profile: t("W_PROFILE", b.weights.profile),
      website: t("W_WEBSITE", b.weights.website),
      github: t("W_GITHUB", b.weights.github),
      engagement: t("W_ENGAGEMENT", b.weights.engagement),
      technicalDepth: t("W_TECH", b.weights.technicalDepth),
      price: t("W_PRICE", b.weights.price),
      onchain: t("W_ONCHAIN", b.weights.onchain),
    },
    penalty: { high: t("RF_HIGH", b.penalty.high), med: t("RF_MED", b.penalty.med), low: t("RF_LOW", b.penalty.low) },
    decay: t("RF_DECAY", b.decay),
    maxPenalty: t("RF_CAP", b.maxPenalty),
    thresholds: { high: t("V_HIGH", b.thresholds.high), monitor: t("V_MONITOR", b.thresholds.monitor) },
    exemptPatterns: b.exemptPatterns,
  };
  return { cfg, overrides };
}

function loadReports(): { name: string; report: AnalysisReport }[] {
  let files: string[] = [];
  try {
    files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.map((f) => ({
    name: f.replace(/\.json$/, ""),
    report: JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as AnalysisReport,
  }));
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);

function main() {
  const { cfg, overrides } = configFromEnv();
  let reports = loadReports();
  if (reports.length === 0) {
    // Auto-seed the synthetic anchors so the loop is immediately usable
    mkdirSync(DIR, { recursive: true });
    const anchors: Array<{ name: string; report: AnalysisReport }> = [
      { name: "_synthetic-early-gem", report: makeReport({ account: { handle: "_synthetic-early-gem", displayName: "Early Gem" }, github: { url: "https://github.com/anon/gem", detected: true, score: 72, stars: 38, recentCommits: 55, contributors: 1 }, onchain: { holderCount: 5200, traders24h: 900, trades24h: 28000, firstTradeAt: null, smartMoney: null, source: "bitquery", notes: "" }, redFlags: [{ severity: "high", code: "pump_fun_token", message: "pump.fun" }, { severity: "high", code: "anonymous_team", message: "anon dev" }] }) },
      { name: "_synthetic-empty-shell", report: makeReport({ account: { handle: "_synthetic-empty-shell", displayName: "Empty Shell" }, profile: { followerQuality: { score: 10, notes: "bots" } }, github: { url: null, detected: false, score: 0 }, website: { url: null, detected: false, score: 5 }, technicalDepth: { score: 5 }, redFlags: [{ severity: "high", code: "no_code", message: "no repo" }] }) },
    ];
    for (const a of anchors) {
      writeFileSync(path.join(DIR, `${a.name}.json`), JSON.stringify(a.report, null, 2));
    }
    console.log("Seeded synthetic anchor reports (no real data present).");
    reports = loadReports();
  }

  const wsum = Object.values(cfg.weights).reduce((a, b) => a + b, 0);
  console.log(`\nScoring ${reports.length} cached report(s)`);
  console.log(
    `config: weights P${cfg.weights.profile} W${cfg.weights.website} G${cfg.weights.github} E${cfg.weights.engagement} T${cfg.weights.technicalDepth} $${cfg.weights.price} O${cfg.weights.onchain}` +
      ` | penalty h${cfg.penalty.high}/m${cfg.penalty.med}/l${cfg.penalty.low} decay ${cfg.decay} cap ${cfg.maxPenalty}` +
      ` | verdict >=${cfg.thresholds.high} High >=${cfg.thresholds.monitor} Monitor`,
  );
  if (Math.abs(wsum - 1) > 1e-9) console.log(`WARN: weights sum to ${wsum.toFixed(3)} (not 1.0)`);
  if (overrides.length) console.log(`overrides: ${overrides.join(" ")}`);
  console.log();

  console.log(
    `  ${pad("report", 22)}${pad("prof", 6)}${pad("site", 6)}${pad("gh", 6)}${pad("eng", 6)}${pad("tech", 6)}${pad("price", 6)}${pad("onch", 6)}${pad("pen", 6)}${pad("overall", 9)}verdict`,
  );
  console.log(`  ${"-".repeat(80)}`);
  const rows = reports
    .map(({ name, report }) => ({
      name,
      s: computeScores(report, cfg),
      pen: redFlagPenalty(report.redFlags, cfg),
    }))
    .sort((a, b) => b.s.overall - a.s.overall);
  for (const { name, s, pen } of rows) {
    console.log(
      `  ${pad(name, 22)}${pad(s.profile, 6)}${pad(s.website, 6)}${pad(s.github, 6)}${pad(s.engagement, 6)}${pad(s.technicalDepth, 6)}${pad(s.price, 6)}${pad(s.onchain, 6)}${pad(`-${pen}`, 6)}${pad(s.overall, 9)}${s.verdict}`,
    );
  }
  console.log();
}

main();
