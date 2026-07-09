/**
 * Offline calibration of launchScore against labeled outcomes.
 *
 * Load rows with T0 LaunchFeatures + 24h outcome labels (from backfill JSONL
 * or synthetic fixtures), evaluate a LaunchScoreConfig, and grid-search weights
 * to improve lift@top-decile / precision@K. No I/O, no LLM.
 */
import {
  computeLaunchScore,
  DEFAULT_LAUNCH_SCORE,
  type LaunchFeatures,
  type LaunchScoreConfig,
} from "@/lib/schema/launch-score";
import type { LaunchOutcome } from "@/lib/schema/outcomes";
import { computeOutcome } from "@/lib/schema/outcomes";

export interface LabeledLaunch {
  features: LaunchFeatures;
  /** Prefer explicit success; else derived from label. */
  success24h?: boolean | null;
  label?: LaunchOutcome["label"];
  ret24h?: number | null;
  /** Optional; ignored when re-scoring under a new config. */
  launchScore?: number;
  vetoed?: boolean;
}

export interface CalibrateMetrics {
  n: number;
  nSuccess: number;
  baseSuccessRate: number;
  /** Precision among top-K by score (non-vetoed ranked first). */
  precisionAtK: number | null;
  k: number;
  /** Success rate in top decile / base rate (1 = no lift). */
  liftTopDecile: number | null;
  topDecileSuccessRate: number | null;
  /** avg(score|success) - avg(score|!success) */
  gap: number | null;
  /** Pairwise rank agreement score vs ret24h in [-1,1]; null if no ret24h. */
  rankCorr: number | null;
}

/**
 * "Good launch" for ranking metrics — not merely "didn't go to zero".
 * Prefer explicit ok/strong labels; else ret24h ≥ 0 (flat or green).
 * success24h (not −90%) is only a last resort.
 */
export function isSuccess(row: LabeledLaunch): boolean | null {
  if (row.label === "ok" || row.label === "strong") return true;
  if (row.label === "rugged" || row.label === "weak") return false;
  if (row.ret24h != null && Number.isFinite(row.ret24h)) return row.ret24h >= 0;
  if (row.success24h === true) return true;
  if (row.success24h === false) return false;
  return null;
}

export function normalizeWeights(
  w: LaunchScoreConfig["weights"],
): LaunchScoreConfig["weights"] {
  const sum =
    w.traction + w.safety + w.smartMoney + w.market + w.social || 1;
  return {
    traction: w.traction / sum,
    safety: w.safety / sum,
    smartMoney: w.smartMoney / sum,
    market: w.market / sum,
    social: w.social / sum,
  };
}

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Pairwise concordance of score order vs ret24h order. */
export function pairwiseRankCorr(
  scores: number[],
  rets: Array<number | null>,
): number | null {
  let conc = 0;
  let disc = 0;
  const n = scores.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ri = rets[i];
      const rj = rets[j];
      if (ri == null || rj == null) continue;
      const ds = scores[i] - scores[j];
      const dr = ri - rj;
      if (ds === 0 || dr === 0) continue;
      if (ds * dr > 0) conc++;
      else disc++;
    }
  }
  const tot = conc + disc;
  return tot ? (conc - disc) / tot : null;
}

export function evaluateConfig(
  rows: LabeledLaunch[],
  cfg: LaunchScoreConfig = DEFAULT_LAUNCH_SCORE,
  opts: { k?: number } = {},
): CalibrateMetrics {
  const k = opts.k ?? 10;
  const labeled = rows
    .map((r) => {
      const result = computeLaunchScore(r.features, cfg);
      const success = isSuccess(r);
      return {
        score: result.vetoed ? 0 : result.score,
        vetoed: result.vetoed,
        success,
        ret24h: r.ret24h ?? null,
      };
    })
    .filter((r) => r.success != null) as Array<{
    score: number;
    vetoed: boolean;
    success: boolean;
    ret24h: number | null;
  }>;

  const n = labeled.length;
  const nSuccess = labeled.filter((r) => r.success).length;
  const baseSuccessRate = n ? nSuccess / n : 0;

  const ranked = [...labeled].sort((a, b) => b.score - a.score);
  const topK = ranked.slice(0, Math.min(k, ranked.length));
  const precisionAtK = topK.length
    ? topK.filter((r) => r.success).length / topK.length
    : null;

  const decileN = Math.max(1, Math.floor(ranked.length / 10));
  const topDecile = ranked.slice(0, decileN);
  const topDecileSuccessRate = topDecile.length
    ? topDecile.filter((r) => r.success).length / topDecile.length
    : null;
  const liftTopDecile =
    topDecileSuccessRate != null && baseSuccessRate > 0
      ? topDecileSuccessRate / baseSuccessRate
      : topDecileSuccessRate != null && baseSuccessRate === 0
        ? null
        : null;

  const succScores = labeled.filter((r) => r.success).map((r) => r.score);
  const failScores = labeled.filter((r) => !r.success).map((r) => r.score);
  const aS = avg(succScores);
  const aF = avg(failScores);
  const gap = aS != null && aF != null ? aS - aF : null;

  const rankCorr = pairwiseRankCorr(
    labeled.map((r) => r.score),
    labeled.map((r) => r.ret24h),
  );

  return {
    n,
    nSuccess,
    baseSuccessRate,
    precisionAtK,
    k: topK.length,
    liftTopDecile,
    topDecileSuccessRate,
    gap,
    rankCorr,
  };
}

/** Compare metrics for grid search ranking. Higher is better. */
export function metricsScore(m: CalibrateMetrics): number {
  // Primary: lift; secondary: precision@K; tertiary: gap
  const lift = m.liftTopDecile ?? 0;
  const prec = m.precisionAtK ?? 0;
  const gap = (m.gap ?? 0) / 100;
  return lift * 10 + prec * 3 + gap;
}

export function gridSearchWeights(
  rows: LabeledLaunch[],
  opts: {
    k?: number;
    /** Step for weight grid on each axis (before normalize). Default 0.1 */
    step?: number;
    base?: LaunchScoreConfig;
  } = {},
): {
  baseline: CalibrateMetrics;
  bestCfg: LaunchScoreConfig;
  bestMetrics: CalibrateMetrics;
  tried: number;
} {
  const base = opts.base ?? DEFAULT_LAUNCH_SCORE;
  const step = opts.step ?? 0.15;
  const baseline = evaluateConfig(rows, base, { k: opts.k });

  const values: number[] = [];
  for (let v = 0; v <= 1.0001; v += step) values.push(Math.round(v * 100) / 100);

  let bestCfg = base;
  let bestMetrics = baseline;
  let bestS = metricsScore(baseline);
  let tried = 0;

  // Coarse grid: fix social/market small or free; iterate main three
  for (const traction of values) {
    for (const safety of values) {
      for (const smartMoney of values) {
        for (const market of [0, 0.1, 0.2]) {
          for (const social of [0, 0.1, 0.2]) {
            const raw = { traction, safety, smartMoney, market, social };
            const sum =
              raw.traction + raw.safety + raw.smartMoney + raw.market + raw.social;
            if (sum < 0.5) continue;
            const weights = normalizeWeights(raw);
            // Avoid degenerate single-signal configs (overfit synthetic noise).
            if (
              weights.traction > 0.55 ||
              weights.safety > 0.55 ||
              weights.smartMoney > 0.55
            ) {
              continue;
            }
            const cfg: LaunchScoreConfig = { ...base, weights };
            const m = evaluateConfig(rows, cfg, { k: opts.k });
            tried++;
            const s = metricsScore(m);
            if (s > bestS + 1e-9) {
              bestS = s;
              bestCfg = cfg;
              bestMetrics = m;
            }
          }
        }
      }
    }
  }

  return { baseline, bestCfg, bestMetrics, tried };
}

/**
 * Synthetic corpus: features correlated with outcomes so calibrate has signal.
 * quality ~ [0,1] drives holders/liq/safety and ret24h.
 */
export function makeSyntheticLabeledLaunches(n = 80, seed = 42): LabeledLaunch[] {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };

  const rows: LabeledLaunch[] = [];
  for (let i = 0; i < n; i++) {
    const quality = rand(); // latent "true" quality
    const noise = (rand() - 0.5) * 0.35;
    const q = Math.max(0, Math.min(1, quality + noise * 0.3));

    const holders = Math.round(30 + q * 4000 + rand() * 200);
    const traders24h = Math.round(5 + q * 600 + rand() * 40);
    const liquidityUsd = Math.round(1000 + q * 80_000 + rand() * 5000);
    const marketCapUsd = Math.round(10_000 + q * 500_000);
    const volume24hUsd = Math.round(marketCapUsd * (0.02 + q * 0.2));
    const top10 = 15 + (1 - q) * 70 + rand() * 10; // worse quality → more concentrated
    const riskScore = 1 + (1 - q) * 8 + rand();
    const mintRenounced = q > 0.35;
    const freezeRenounced = q > 0.4;
    const smartMoneyCount = q > 0.6 ? Math.round(q * 15) : q > 0.4 ? 1 : 0;
    const hasTwitter = q > 0.25 || rand() > 0.5;
    const followers = hasTwitter ? Math.round(20 + q * 2000) : null;

    const features: LaunchFeatures = {
      mint: `SynthMint${i.toString().padStart(4, "0")}pump`,
      holders,
      traders24h,
      trades24h: traders24h * 3,
      liquidityUsd,
      marketCapUsd,
      volume24hUsd,
      mintRenounced,
      freezeRenounced,
      top10HolderPct: Math.min(99, top10),
      riskScore: Math.min(10, riskScore),
      smartMoneyCount,
      hasTwitter,
      followers,
      graduatedAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
      sources: ["synthetic"],
    };

    // True return driven by quality — most pump.fun grads dump (success ~25–40%).
    // quality 0 → ~-99%; only high quality clears 0% / +50%.
    const ret24h = -0.99 + Math.pow(quality, 1.6) * 1.7 + (rand() - 0.5) * 0.15;
    const clamped = Math.max(-0.99, Math.min(2.5, ret24h));
    const p1 = Math.max(0.01, 1 + clamped);
    const outcome = computeOutcome({ priceUsd: 1 }, { h24: { priceUsd: p1 } });

    rows.push({
      features,
      ret24h: outcome.ret24h,
      label: outcome.label,
      success24h: outcome.success24h,
    });
  }
  return rows;
}

/** Parse a JSONL line from backfill-outcomes or calibrate fixtures. */
export function parseLabeledLine(raw: unknown): LabeledLaunch | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  let features = o.features as LaunchFeatures | undefined;
  if (!features && typeof o.mint === "string") {
    // Minimal row: cannot re-score without features
    return null;
  }
  if (!features) return null;

  const outcome = o.outcome as LaunchOutcome | undefined;
  return {
    features,
    launchScore: typeof o.launchScore === "number" ? o.launchScore : undefined,
    vetoed: typeof o.vetoed === "boolean" ? o.vetoed : undefined,
    success24h: outcome?.success24h ?? (o.success24h as boolean | null | undefined),
    label: outcome?.label ?? (o.label as LaunchOutcome["label"] | undefined),
    ret24h: outcome?.ret24h ?? (typeof o.ret24h === "number" ? o.ret24h : null),
  };
}
