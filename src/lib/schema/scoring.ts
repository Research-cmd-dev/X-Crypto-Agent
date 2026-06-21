import { z } from "zod";
import type { AnalysisReport, Price, RedFlag } from "@/lib/schema/analysis";

/** Sub-score weights (must sum to 1.0). */
export const WEIGHTS = {
  profile: 0.25,
  website: 0.2,
  github: 0.2,
  engagement: 0.15,
  technicalDepth: 0.1,
  price: 0.1,
} as const;

/** Red-flag penalty subtracted from the overall (per flag), floored at 0. */
export const RED_FLAG_PENALTY: Record<RedFlag["severity"], number> = {
  high: 15,
  med: 7,
  low: 3,
};

/** Verdict thresholds on the overall score. */
export const VERDICT_THRESHOLDS = { high: 70, monitor: 40 } as const;

export const verdictSchema = z.enum(["High", "Monitor", "Avoid"]);
export type Verdict = z.infer<typeof verdictSchema>;

export interface ScoreBreakdown {
  profile: number;
  website: number;
  github: number;
  engagement: number;
  technicalDepth: number;
  price: number;
  overall: number;
  verdict: Verdict;
}

/** Clamp any number to an integer in [0, 100]. */
export function clampScore(n: number | null | undefined): number {
  if (n == null || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
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

export function redFlagPenalty(flags: RedFlag[]): number {
  return flags.reduce((sum, f) => sum + (RED_FLAG_PENALTY[f.severity] ?? 0), 0);
}

export function toVerdict(overall: number): Verdict {
  if (overall >= VERDICT_THRESHOLDS.high) return "High";
  if (overall >= VERDICT_THRESHOLDS.monitor) return "Monitor";
  return "Avoid";
}

/**
 * Deterministic, auditable scoring: weighted combine of clamped sub-scores
 * minus red-flag penalties, mapped to a verdict.
 */
export function computeScores(report: AnalysisReport): ScoreBreakdown {
  const profile = clampScore(report.profile.followerQuality.score);
  const website = clampScore(report.website.score);
  const github = clampScore(report.github.score);
  const engagement = clampScore(report.engagement.momentumScore);
  const technicalDepth = clampScore(report.technicalDepth.score);
  const price = clampScore(priceContextScore(report.price));

  const weighted =
    WEIGHTS.profile * profile +
    WEIGHTS.website * website +
    WEIGHTS.github * github +
    WEIGHTS.engagement * engagement +
    WEIGHTS.technicalDepth * technicalDepth +
    WEIGHTS.price * price;

  const overall = clampScore(weighted - redFlagPenalty(report.redFlags));

  return {
    profile,
    website,
    github,
    engagement,
    technicalDepth,
    price,
    overall,
    verdict: toVerdict(overall),
  };
}
