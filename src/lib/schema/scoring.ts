import { z } from "zod";
import type { AnalysisReport, Price, RedFlag } from "@/lib/schema/analysis";

/**
 * ALPHA scoring profile. Tuned for the thesis: catch low-float early gems that
 * smart money is piling into before the crowd. Smart-money signal is weighted
 * highest, followed by engagement momentum and earliness. Website/GitHub matter
 * less as *positive* weight (early gems rarely have mature sites/repos) but still
 * feed red flags as a scam/credibility check. Weights sum to 1.0.
 */
export const ALPHA_WEIGHTS = {
  smartMoney: 0.28,
  engagement: 0.18,
  earliness: 0.15,
  profile: 0.12,
  technicalDepth: 0.1,
  website: 0.07,
  github: 0.06,
  price: 0.04,
} as const;

/** Human labels for each weighted signal (used by explainScore). */
export const SIGNAL_LABELS: Record<keyof typeof ALPHA_WEIGHTS, string> = {
  smartMoney: "Smart money",
  engagement: "Engagement momentum",
  earliness: "Earliness / low float",
  profile: "Follower quality",
  technicalDepth: "Technical depth",
  website: "Website",
  github: "GitHub",
  price: "Price/liquidity",
};

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
  smartMoney: number;
  engagement: number;
  earliness: number;
  profile: number;
  technicalDepth: number;
  website: number;
  github: number;
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
  if (mc == null || vol == null || mc <= 0) return 40;
  const liquidity = vol / mc;
  if (liquidity >= 0.1) return 80;
  if (liquidity >= 0.03) return 65;
  if (liquidity >= 0.005) return 45;
  return 25; // very thin liquidity — often a warning sign
}

// ── Earliness / low-float (the alpha timing signal) ─────────────────────────

function ageScore(createdAt: string | null): number {
  if (!createdAt) return 50;
  const ms = Date.parse(createdAt);
  if (Number.isNaN(ms)) return 50;
  const days = (Date.now() - ms) / 86_400_000;
  if (days < 14) return 55; // brand new — opportunity, but higher scam risk
  if (days <= 365) return 90; // weeks-to-months old: early but established — sweet spot
  if (days <= 730) return 60;
  return 35; // 2y+ — not early
}

function followerBandScore(followers: number | null): number {
  if (followers == null) return 50;
  if (followers < 200) return 55; // tiny / unproven
  if (followers <= 50_000) return 90; // early but real traction
  if (followers <= 250_000) return 60;
  return 35; // already large — late
}

function mcapBandScore(mc: number | null): number {
  if (mc == null) return 80; // pre-token = earliest entry
  if (mc < 5_000_000) return 90; // microcap
  if (mc < 50_000_000) return 60;
  if (mc < 250_000_000) return 40;
  return 20; // large / late
}

/** Deterministic earliness score: young-but-established + small-but-real + microcap. */
export function earlinessScore(report: AnalysisReport): number {
  const age = ageScore(report.account.createdAt);
  const band = followerBandScore(report.profile.followerCount);
  const mcap = mcapBandScore(report.price.marketCapUsd);
  return clampScore(0.4 * age + 0.3 * band + 0.3 * mcap);
}

export function redFlagPenalty(flags: RedFlag[]): number {
  return flags.reduce((sum, f) => sum + (RED_FLAG_PENALTY[f.severity] ?? 0), 0);
}

export function toVerdict(overall: number): Verdict {
  if (overall >= VERDICT_THRESHOLDS.high) return "High";
  if (overall >= VERDICT_THRESHOLDS.monitor) return "Monitor";
  return "Avoid";
}

/** Per-signal clamped sub-scores (before weighting). */
function subScores(report: AnalysisReport): Record<keyof typeof ALPHA_WEIGHTS, number> {
  return {
    smartMoney: clampScore(report.smartMoney.score),
    engagement: clampScore(report.engagement.momentumScore),
    earliness: earlinessScore(report),
    profile: clampScore(report.profile.followerQuality.score),
    technicalDepth: clampScore(report.technicalDepth.score),
    website: clampScore(report.website.score),
    github: clampScore(report.github.score),
    price: clampScore(priceContextScore(report.price)),
  };
}

/**
 * Deterministic, auditable scoring: weighted combine of clamped sub-scores
 * (smart money weighted highest) minus red-flag penalties, mapped to a verdict.
 */
export function computeScores(report: AnalysisReport): ScoreBreakdown {
  const s = subScores(report);
  const weighted = (Object.keys(ALPHA_WEIGHTS) as (keyof typeof ALPHA_WEIGHTS)[]).reduce(
    (sum, k) => sum + ALPHA_WEIGHTS[k] * s[k],
    0,
  );
  const overall = clampScore(weighted - redFlagPenalty(report.redFlags));
  return { ...s, overall, verdict: toVerdict(overall) };
}

// ── "Why this score" explanation ────────────────────────────────────────────

export interface ScoreContribution {
  key: keyof typeof ALPHA_WEIGHTS;
  label: string;
  weight: number;
  score: number;
  /** Points this signal contributed to the overall (weight × score). */
  points: number;
}

export interface ScorePenalty {
  code: string;
  severity: RedFlag["severity"];
  points: number;
}

export interface ScoreExplanation {
  contributions: ScoreContribution[];
  penalties: ScorePenalty[];
  overall: number;
  verdict: Verdict;
  headline: string;
}

/**
 * Deterministic "why this score" breakdown: every signal's point contribution
 * (sorted high→low) plus red-flag penalties and a one-line headline. Recomputes
 * from the stored report, so it never drifts from the persisted score.
 */
export function explainScore(report: AnalysisReport): ScoreExplanation {
  const s = subScores(report);
  const breakdown = computeScores(report);

  const contributions: ScoreContribution[] = (
    Object.keys(ALPHA_WEIGHTS) as (keyof typeof ALPHA_WEIGHTS)[]
  )
    .map((key) => ({
      key,
      label: SIGNAL_LABELS[key],
      weight: ALPHA_WEIGHTS[key],
      score: s[key],
      points: Math.round(ALPHA_WEIGHTS[key] * s[key] * 10) / 10,
    }))
    .sort((a, b) => b.points - a.points);

  const penalties: ScorePenalty[] = report.redFlags.map((f) => ({
    code: f.code,
    severity: f.severity,
    points: RED_FLAG_PENALTY[f.severity] ?? 0,
  }));

  const top = contributions.slice(0, 3).map((c) => c.label.toLowerCase());
  const penaltyTotal = redFlagPenalty(report.redFlags);
  const headline =
    `${breakdown.verdict} (${breakdown.overall}/100). ` +
    `Driven by ${top.join(", ")}.` +
    (penaltyTotal > 0 ? ` −${penaltyTotal} from ${report.redFlags.length} red flag(s).` : "");

  return {
    contributions,
    penalties,
    overall: breakdown.overall,
    verdict: breakdown.verdict,
    headline,
  };
}
