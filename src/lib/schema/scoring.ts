import { z } from "zod";
import type { AnalysisReport, Price, Onchain, RedFlag } from "@/lib/schema/analysis";

/**
 * Sub-score weights (must sum to 1.0). Weighted toward early-stage substance +
 * traction: on-chain participation and the team/code carry as much as profile.
 * Tune freely via the scoring loop (W_* env overrides in scripts/score.ts).
 */
export const WEIGHTS = {
  profile: 0.2,
  website: 0.1,
  github: 0.15,
  engagement: 0.15,
  technicalDepth: 0.1,
  price: 0.1,
  onchain: 0.2,
} as const;

/**
 * Red-flag penalties, subtracted from the weighted base (floored at 0 in
 * `computeScores`). Three guards stop a handful of flags from auto-failing an
 * otherwise strong project — a real one should be *de-rated by* its risks, not
 * zeroed:
 *   1. Modest per-severity weights.
 *   2. Diminishing returns — flags apply strongest-first, each subsequent one
 *      discounted by RED_FLAG_DECAY (dampens flag-stacking + run-to-run variance).
 *   3. MAX_RED_FLAG_PENALTY caps the total drag.
 */
export const RED_FLAG_PENALTY: Record<RedFlag["severity"], number> = {
  high: 12,
  med: 5,
  low: 2,
};

/** Each additional (lower-ranked) flag is discounted by this factor. */
export const RED_FLAG_DECAY = 0.6;

/** Hard cap on the total red-flag penalty. */
export const MAX_RED_FLAG_PENALTY = 30;

/** Verdict thresholds on the overall score. */
export const VERDICT_THRESHOLDS = { high: 70, monitor: 40 } as const;

/**
 * Flags that must NOT reduce the score. The goal is to surface *super-early*
 * projects that could be real, so traits that are simply normal at that stage
 * carry zero penalty:
 *   - pump.fun / bonding-curve launches — how most early Solana projects start.
 *   - anonymous / pseudonymous teams — the norm in crypto; having ANY real dev
 *     or code at all is a positive, not a risk.
 * Matched against the flag code AND message, so it is robust to model wording.
 */
export const PENALTY_EXEMPT_PATTERNS: RegExp[] = [
  /pump[\s._-]?fun|bonding[\s._-]?curve/i,
  /\b(anon|anonymous|pseudonym|undoxx|no[\s._-]?doxx|unknown[\s._-]?team|key[\s._-]?person)/i,
];

export const verdictSchema = z.enum(["High", "Monitor", "Avoid"]);
export type Verdict = z.infer<typeof verdictSchema>;

/**
 * Every tunable scoring knob in one object so calibration can be swept without
 * editing source (see scripts/score.ts). Defaults come from the consts above.
 */
export interface ScoringConfig {
  weights: Record<keyof typeof WEIGHTS, number>;
  penalty: Record<RedFlag["severity"], number>;
  decay: number;
  maxPenalty: number;
  thresholds: { high: number; monitor: number };
  exemptPatterns: RegExp[];
}

export const DEFAULT_SCORING: ScoringConfig = {
  weights: { ...WEIGHTS },
  penalty: { ...RED_FLAG_PENALTY },
  decay: RED_FLAG_DECAY,
  maxPenalty: MAX_RED_FLAG_PENALTY,
  thresholds: { ...VERDICT_THRESHOLDS },
  exemptPatterns: PENALTY_EXEMPT_PATTERNS,
};

export interface ScoreBreakdown {
  profile: number;
  website: number;
  github: number;
  engagement: number;
  technicalDepth: number;
  price: number;
  onchain: number;
  overall: number;
  verdict: Verdict;
}

/** Clamp any number to an integer in [0, 100]. */
export function clampScore(n: number | null | undefined): number {
  if (n == null || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** True if a flag is a normal early-stage trait and must not be penalized. */
export function isPenaltyExempt(
  flag: RedFlag,
  patterns: RegExp[] = PENALTY_EXEMPT_PATTERNS,
): boolean {
  const hay = `${flag.code} ${flag.message}`;
  return patterns.some((re) => re.test(hay));
}

/**
 * Derive a transparent 0-100 "market/liquidity context" score from price data.
 * Pre-token projects are treated as neutral (not penalized for having no token).
 */
export function priceContextScore(price: Price): number {
  if (!price.token) return 50; // no token yet — neutral for early-stage projects
  const { marketCapUsd: mc, volume24hUsd: vol } = price;
  if (mc == null || vol == null || mc <= 0) return 40; // token exists but data missing
  const liquidity = vol / mc; // 24h volume relative to market cap
  if (liquidity >= 0.1) return 80;
  if (liquidity >= 0.03) return 65;
  if (liquidity >= 0.005) return 45;
  return 25; // very thin liquidity — often a warning sign
}

/**
 * On-chain traction score (0-100) from holders + 24h active traders + trades —
 * the strongest *early* signal of a real, live project. No token / no on-chain
 * data is neutral (50), never penalized.
 */
export function onchainScore(o: Onchain): number {
  if (o.holderCount == null && o.traders24h == null && o.trades24h == null) return 50;
  let s = 30;
  const holders = o.holderCount ?? 0;
  if (holders >= 5000) s += 30;
  else if (holders >= 1000) s += 22;
  else if (holders >= 300) s += 14;
  else if (holders >= 50) s += 7;
  const traders = o.traders24h ?? 0;
  if (traders >= 1000) s += 25;
  else if (traders >= 200) s += 17;
  else if (traders >= 50) s += 10;
  else if (traders >= 10) s += 5;
  if ((o.trades24h ?? 0) >= 100) s += 5; // active market
  return clampScore(s);
}

export function redFlagPenalty(
  flags: RedFlag[],
  cfg: ScoringConfig = DEFAULT_SCORING,
): number {
  const weights = flags
    .filter((f) => !isPenaltyExempt(f, cfg.exemptPatterns))
    .map((f) => cfg.penalty[f.severity] ?? 0)
    .filter((w) => w > 0)
    .sort((a, b) => b - a); // strongest first
  const raw = weights.reduce((sum, w, i) => sum + w * cfg.decay ** i, 0);
  return Math.min(cfg.maxPenalty, Math.round(raw));
}

export function toVerdict(
  overall: number,
  thresholds: { high: number; monitor: number } = DEFAULT_SCORING.thresholds,
): Verdict {
  if (overall >= thresholds.high) return "High";
  if (overall >= thresholds.monitor) return "Monitor";
  return "Avoid";
}

/**
 * Deterministic, auditable scoring: weighted combine of clamped sub-scores
 * minus red-flag penalties, mapped to a verdict. Pass a `cfg` to sweep knobs.
 */
export function computeScores(
  report: AnalysisReport,
  cfg: ScoringConfig = DEFAULT_SCORING,
): ScoreBreakdown {
  const profile = clampScore(report.profile.followerQuality.score);
  const website = clampScore(report.website.score);
  const github = clampScore(report.github.score);
  const engagement = clampScore(report.engagement.momentumScore);
  const technicalDepth = clampScore(report.technicalDepth.score);
  const price = clampScore(priceContextScore(report.price));
  const onchain = clampScore(onchainScore(report.onchain));

  const w = cfg.weights;
  const weighted =
    w.profile * profile +
    w.website * website +
    w.github * github +
    w.engagement * engagement +
    w.technicalDepth * technicalDepth +
    w.price * price +
    w.onchain * onchain;

  const overall = clampScore(weighted - redFlagPenalty(report.redFlags, cfg));

  return {
    profile,
    website,
    github,
    engagement,
    technicalDepth,
    price,
    onchain,
    overall,
    verdict: toVerdict(overall, cfg.thresholds),
  };
}
