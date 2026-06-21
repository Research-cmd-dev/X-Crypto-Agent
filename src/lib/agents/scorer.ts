import type { AnalysisReport, RedFlag } from "@/lib/schema/analysis";
import {
  computeScores,
  DEFAULT_PROFILE,
  type ScoreBreakdown,
  type ScoringProfile,
} from "@/lib/schema/scoring";

/**
 * Deterministic structural red flags that complement the LLM-surfaced ones.
 * Kept auditable and code-driven so scoring is reproducible.
 */
export function deriveStructuralRedFlags(report: AnalysisReport): RedFlag[] {
  const flags: RedFlag[] = [];

  if (!report.github.detected) {
    flags.push({ severity: "med", code: "no_github", message: "No GitHub presence detected." });
  }
  if (!report.website.detected) {
    flags.push({ severity: "low", code: "no_website", message: "No website detected." });
  }
  if (report.profile.followerQuality.score < 25) {
    flags.push({
      severity: "med",
      code: "low_follower_quality",
      message: "Follower base appears low quality (possible bots / purchased).",
    });
  }
  const ratio = report.profile.followerRatio;
  if (ratio != null && ratio < 0.3 && (report.profile.followingCount ?? 0) > 2000) {
    flags.push({
      severity: "low",
      code: "follow_farming",
      message: "Following far more accounts than followers (follow-farming pattern).",
    });
  }

  return flags;
}

/** Merge two red-flag lists, de-duplicating by code (first wins). */
export function mergeRedFlags(a: RedFlag[], b: RedFlag[]): RedFlag[] {
  const seen = new Set(a.map((f) => f.code));
  return [...a, ...b.filter((f) => !seen.has(f.code))];
}

export interface ScorerResult {
  scores: ScoreBreakdown;
  redFlags: RedFlag[];
}

/**
 * The Scorer: merges structural + LLM red flags, then computes the deterministic
 * weighted score + verdict over the fully-assembled report.
 */
export function runScorer(
  report: AnalysisReport,
  profile: ScoringProfile = DEFAULT_PROFILE,
): ScorerResult {
  const redFlags = mergeRedFlags(report.redFlags, deriveStructuralRedFlags(report));
  const scored: AnalysisReport = { ...report, redFlags };
  return { scores: computeScores(scored, profile), redFlags };
}
