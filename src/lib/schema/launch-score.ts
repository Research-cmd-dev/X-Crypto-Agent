/**
 * Pump.fun launch probability score (heuristic v1).
 *
 * Pure function over a flat feature pack — no I/O, no LLM. Features can come from
 * Solana Tracker, Bitquery, Birdeye/DexScreener, GMGN, or any future provider.
 * Missing fields are treated as neutral (not automatic zeros), so the ranker
 * degrades gracefully when a data source is offline or swapped out.
 *
 * Output is separate from the multi-agent High/Monitor/Avoid legitimacy score:
 * this ranks *new graduates* for attention before expensive deep analysis.
 */

export interface LaunchFeatures {
  mint: string;
  /** Unique holders */
  holders: number | null;
  traders24h: number | null;
  trades24h: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  /** Authority renounced (any security source). */
  mintRenounced: boolean | null;
  freezeRenounced: boolean | null;
  /**
   * Top-10 holder concentration. Accepts 0–1 fraction or 0–100 percent;
   * normalized internally.
   */
  top10HolderPct: number | null;
  /**
   * Generic risk score from a security source. Higher = worse.
   * Interpreted on ~1–10 scale when present; null = unknown.
   */
  riskScore: number | null;
  /** Count of smart-money / notable wallets if available. */
  smartMoneyCount: number | null;
  hasTwitter: boolean;
  /** X followers when known (for holder/follower divergence). */
  followers: number | null;
  graduatedAt: string | null;
  /** Which providers filled fields (for debugging / board). */
  sources?: string[];
}

export interface LaunchScoreConfig {
  weights: {
    traction: number;
    safety: number;
    smartMoney: number;
    market: number;
    social: number;
  };
  /** Top-10 concentration at or above this % → hard veto. */
  vetoTop10Pct: number;
  /** Risk score at or above this → hard veto (1–10 scale). */
  vetoRiskScore: number;
  /** Min launchScore to pass the funnel (when not vetoed). */
  minScoreForDeepDive: number;
  /** Max candidates to deep-analyze per discovery window. */
  topK: number;
}

export const DEFAULT_LAUNCH_SCORE: LaunchScoreConfig = {
  weights: {
    traction: 0.3,
    safety: 0.25,
    smartMoney: 0.25,
    market: 0.1,
    social: 0.1,
  },
  vetoTop10Pct: 80,
  vetoRiskScore: 9,
  minScoreForDeepDive: 45,
  topK: 10,
};

export interface LaunchScoreResult {
  score: number;
  vetoed: boolean;
  vetoReasons: string[];
  reasons: string[];
  parts: {
    traction: number;
    safety: number;
    smartMoney: number;
    market: number;
    social: number;
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Normalize top-10 concentration to 0–100 percent. */
export function normalizeTop10Pct(raw: number | null | undefined): number | null {
  if (raw == null || Number.isNaN(raw)) return null;
  if (raw >= 0 && raw <= 1) return raw * 100;
  return raw;
}

function tractionScore(f: LaunchFeatures): number {
  if (f.holders == null && f.traders24h == null && f.liquidityUsd == null) return 50;
  let s = 25;
  const h = f.holders ?? 0;
  if (h >= 3000) s += 30;
  else if (h >= 1000) s += 24;
  else if (h >= 300) s += 16;
  else if (h >= 100) s += 10;
  else if (h >= 40) s += 5;

  const t = f.traders24h ?? 0;
  if (t >= 500) s += 25;
  else if (t >= 100) s += 18;
  else if (t >= 30) s += 12;
  else if (t >= 10) s += 6;

  const liq = f.liquidityUsd ?? 0;
  if (liq >= 50_000) s += 15;
  else if (liq >= 15_000) s += 10;
  else if (liq >= 5_000) s += 5;

  return clamp01(s);
}

function safetyScore(f: LaunchFeatures): number {
  const top10 = normalizeTop10Pct(f.top10HolderPct);
  const hasAny =
    f.mintRenounced != null ||
    f.freezeRenounced != null ||
    top10 != null ||
    f.riskScore != null;
  if (!hasAny) return 50; // unknown safety — neutral, not optimistic

  let s = 40;
  if (f.mintRenounced === true) s += 15;
  else if (f.mintRenounced === false) s -= 20;
  if (f.freezeRenounced === true) s += 15;
  else if (f.freezeRenounced === false) s -= 15;

  if (top10 != null) {
    if (top10 <= 25) s += 20;
    else if (top10 <= 40) s += 10;
    else if (top10 <= 55) s += 0;
    else if (top10 <= 70) s -= 15;
    else s -= 30;
  }

  if (f.riskScore != null) {
    // 1–10 style: low risk good
    if (f.riskScore <= 3) s += 15;
    else if (f.riskScore <= 5) s += 5;
    else if (f.riskScore <= 7) s -= 10;
    else s -= 25;
  }

  return clamp01(s);
}

function smartMoneyScore(f: LaunchFeatures): number {
  if (f.smartMoneyCount == null) return 50;
  const n = f.smartMoneyCount;
  if (n >= 20) return 95;
  if (n >= 10) return 85;
  if (n >= 5) return 75;
  if (n >= 2) return 65;
  if (n >= 1) return 55;
  return 35; // known zero smart money — mild drag
}

function marketScore(f: LaunchFeatures): number {
  const mc = f.marketCapUsd;
  const vol = f.volume24hUsd;
  if (mc == null && vol == null) return 50;
  if (mc == null || mc <= 0) return 40;
  if (vol == null) {
    // mcap alone: mid-range post-grad mcaps score higher than dust or already huge
    if (mc >= 50_000 && mc <= 5_000_000) return 60;
    if (mc < 15_000) return 30;
    return 50;
  }
  const ratio = vol / mc;
  if (ratio >= 0.15) return 85;
  if (ratio >= 0.05) return 70;
  if (ratio >= 0.015) return 55;
  return 30;
}

function socialScore(f: LaunchFeatures): number {
  if (!f.hasTwitter) {
    // No social: mild penalty only if we also have few holders (shell)
    if ((f.holders ?? 0) < 50) return 30;
    return 45;
  }
  let s = 65;
  // Divergence: many holders, almost no followers → bot/pump pattern
  if (f.followers != null && f.holders != null && f.holders >= 200) {
    const ratio = f.holders / Math.max(1, f.followers);
    if (ratio >= 20) s -= 25;
    else if (ratio >= 8) s -= 12;
    else if (f.followers >= 200 && ratio < 3) s += 10;
  } else if (f.followers != null) {
    if (f.followers >= 500) s += 15;
    else if (f.followers >= 100) s += 8;
    else if (f.followers < 20) s -= 10;
  }
  return clamp01(s);
}

function hardVetoes(f: LaunchFeatures, cfg: LaunchScoreConfig): string[] {
  const reasons: string[] = [];
  const top10 = normalizeTop10Pct(f.top10HolderPct);
  if (top10 != null && top10 >= cfg.vetoTop10Pct) {
    reasons.push(`top10_concentration_${Math.round(top10)}pct`);
  }
  if (f.riskScore != null && f.riskScore >= cfg.vetoRiskScore) {
    reasons.push(`risk_score_${f.riskScore}`);
  }
  return reasons;
}

/**
 * Compute launch probability score + vetoes + human-readable reasons.
 */
export function computeLaunchScore(
  features: LaunchFeatures,
  cfg: LaunchScoreConfig = DEFAULT_LAUNCH_SCORE,
): LaunchScoreResult {
  const parts = {
    traction: tractionScore(features),
    safety: safetyScore(features),
    smartMoney: smartMoneyScore(features),
    market: marketScore(features),
    social: socialScore(features),
  };

  const w = cfg.weights;
  const weighted =
    w.traction * parts.traction +
    w.safety * parts.safety +
    w.smartMoney * parts.smartMoney +
    w.market * parts.market +
    w.social * parts.social;

  const vetoReasons = hardVetoes(features, cfg);
  const vetoed = vetoReasons.length > 0;
  const score = vetoed ? 0 : clamp01(weighted);

  const reasons: string[] = [];
  if (features.holders != null) reasons.push(`${features.holders} holders`);
  if (features.traders24h != null) reasons.push(`${features.traders24h} traders/24h`);
  if (features.liquidityUsd != null) {
    reasons.push(`liq $${Math.round(features.liquidityUsd).toLocaleString()}`);
  }
  if (features.smartMoneyCount != null && features.smartMoneyCount > 0) {
    reasons.push(`${features.smartMoneyCount} smart $`);
  }
  if (features.hasTwitter) reasons.push("has twitter");
  if (features.mintRenounced === true) reasons.push("mint renounced");
  if (features.freezeRenounced === true) reasons.push("freeze renounced");
  const top10 = normalizeTop10Pct(features.top10HolderPct);
  if (top10 != null) reasons.push(`top10 ${Math.round(top10)}%`);
  if (features.sources?.length) reasons.push(`src:${features.sources.join("+")}`);

  return { score, vetoed, vetoReasons, reasons, parts };
}

/** Rank features highest-first; vetoed sink to bottom. */
export function rankLaunches(
  items: LaunchFeatures[],
  cfg: LaunchScoreConfig = DEFAULT_LAUNCH_SCORE,
): Array<LaunchFeatures & { result: LaunchScoreResult }> {
  return items
    .map((f) => ({ ...f, result: computeLaunchScore(f, cfg) }))
    .sort((a, b) => {
      if (a.result.vetoed !== b.result.vetoed) return a.result.vetoed ? 1 : -1;
      return b.result.score - a.result.score;
    });
}

/** Survivors for expensive deep analysis: not vetoed, score ≥ min, top K. */
export function selectTopKForDeepDive(
  items: LaunchFeatures[],
  cfg: LaunchScoreConfig = DEFAULT_LAUNCH_SCORE,
): Array<LaunchFeatures & { result: LaunchScoreResult }> {
  return rankLaunches(items, cfg)
    .filter((x) => !x.result.vetoed && x.result.score >= cfg.minScoreForDeepDive)
    .slice(0, cfg.topK);
}
