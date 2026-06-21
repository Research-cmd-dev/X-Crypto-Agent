import { z } from "zod";
import type { AnalysisReport, Price, OnChain, RedFlag } from "@/lib/schema/analysis";

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

/**
 * A tunable scoring profile: the per-signal weights plus the verdict thresholds
 * and red-flag penalties. Bundling these makes scoring fully parameterizable so
 * weights can be stored in (and tuned via) the database — `computeScores` and
 * friends take a profile, defaulting to {@link DEFAULT_PROFILE} (the hardcoded
 * ALPHA values) so existing call sites and behavior are unchanged.
 */
export interface ScoringProfile {
  weights: Record<keyof typeof ALPHA_WEIGHTS, number>;
  thresholds: { high: number; monitor: number };
  penalties: Record<RedFlag["severity"], number>;
}

/** Zod schema for validating a profile read from JSONB (weight_versions.profile). */
export const scoringProfileSchema = z.object({
  weights: z.object({
    smartMoney: z.number(),
    engagement: z.number(),
    earliness: z.number(),
    profile: z.number(),
    technicalDepth: z.number(),
    website: z.number(),
    github: z.number(),
    price: z.number(),
  }),
  thresholds: z.object({ high: z.number(), monitor: z.number() }),
  penalties: z.object({ high: z.number(), med: z.number(), low: z.number() }),
});

/** The built-in profile (current hardcoded ALPHA values). */
export const DEFAULT_PROFILE: ScoringProfile = {
  weights: { ...ALPHA_WEIGHTS },
  thresholds: { ...VERDICT_THRESHOLDS },
  penalties: { ...RED_FLAG_PENALTY },
};

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

// ── On-chain signal scoring (GMGN-sourced Solana token candidates) ──────────
// These re-source the same weighted signals from on-chain data. They are used
// in place of the social-derived sub-scores whenever `report.onchain` is set;
// otherwise the original (account-based) logic above applies.

function tokenAgeScore(ageDays: number | null): number {
  if (ageDays == null) return 50;
  if (ageDays < 1) return 55; // brand new — opportunity, but higher rug risk
  if (ageDays <= 90) return 90; // days-to-weeks: early but survived the initial dump
  if (ageDays <= 365) return 60;
  return 35; // old launch — not early
}

function holderBandScore(holders: number | null): number {
  if (holders == null) return 50;
  if (holders < 50) return 45; // too nascent / illiquid
  if (holders <= 3_000) return 90; // early but real distribution — sweet spot
  if (holders <= 20_000) return 65;
  return 45; // already crowded — late
}

/** Smart-money adoption: how many tracked smart wallets hold + net flow direction. */
export function onchainSmartMoneyScore(o: OnChain): number {
  const n = o.smartMoneyCount;
  let base: number;
  if (n == null) base = 50;
  else if (n <= 0) base = 20;
  else if (n <= 2) base = 50;
  else if (n <= 5) base = 70;
  else if (n <= 10) base = 85;
  else base = 95;
  if (o.smartMoneyNetUsd != null) base += o.smartMoneyNetUsd > 0 ? 5 : -15; // distribution is bearish
  return clampScore(base);
}

/** Momentum from price change + holder growth. */
export function onchainMomentumScore(o: OnChain): number {
  const { priceChange24hPct: pc, holderGrowthPct: hg } = o;
  if (pc == null && hg == null) return 50;
  let s = 50;
  if (pc != null) s += Math.max(-25, Math.min(25, pc / 4)); // ±100% → ±25
  if (hg != null) s += Math.max(-15, Math.min(25, hg / 2));
  return clampScore(s);
}

/** Holder quality: penalize top-holder concentration + insider/bundler/sniper dominance. */
export function onchainHolderQualityScore(o: OnChain): number {
  let s = 85;
  if (o.topHolderConcentration != null) s -= o.topHolderConcentration * 80; // 0.5 → −40
  if (o.insiderRatio != null) s -= o.insiderRatio * 60; // 0.3 → −18
  return clampScore(s);
}

/**
 * Per-signal on-chain share when BOTH an on-chain and a social reading exist for
 * the same signal (the rest comes from the social side). Centralized + documented
 * so the on-chain/social balance is visible and adjustable; these could later be
 * promoted to independently-tunable weights once enough matured live social
 * samples exist. A project validated on-chain AND socially is the high-conviction
 * case; a weak/absent X presence drags these signals down (and is flagged).
 */
export const BLEND = { smartMoney: 0.6, engagement: 0.5, profile: 0.5 } as const;

/** Combine an on-chain and a social sub-score. Falls back to whichever exists. */
function blendSignal(onchain: number | null, social: number | null, onchainShare: number): number {
  if (onchain != null && social != null) return clampScore(onchainShare * onchain + (1 - onchainShare) * social);
  return clampScore(onchain ?? social ?? 50);
}

/**
 * Scam/credibility red flags from the SOCIAL layer (complement to
 * {@link securityRedFlags} from the on-chain layer). A migrated token with no
 * linked X account, or a brand-new burner account, are documented scam tells.
 */
export function socialRedFlags(report: AnalysisReport): RedFlag[] {
  const flags: RedFlag[] = [];
  const hasOnchain = report.onchain != null;
  const socialPresent = report.account.userId != null;
  if (hasOnchain && !socialPresent) {
    flags.push({ severity: "med", code: "missing_social", message: "No linked X account found for this token." });
    return flags;
  }
  if (socialPresent && report.account.createdAt) {
    const ms = Date.parse(report.account.createdAt);
    if (!Number.isNaN(ms)) {
      const days = (Date.now() - ms) / 86_400_000;
      if (days < 7) flags.push({ severity: "med", code: "fresh_account", message: `X account is only ${Math.max(0, Math.floor(days))}d old.` });
    }
  }
  return flags;
}

/**
 * Map on-chain security/risk metrics to red flags so they flow through the
 * existing {@link redFlagPenalty} machinery (no new weight key needed). The
 * on-chain analyzer merges these into `report.redFlags`.
 */
export function securityRedFlags(o: OnChain): RedFlag[] {
  const flags: RedFlag[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (o.isHoneypot === true)
    flags.push({ severity: "high", code: "honeypot", message: "Honeypot: sells may be blocked." });
  if (o.rugRatio != null && o.rugRatio >= 0.5)
    flags.push({ severity: "high", code: "rug_risk", message: `High rug risk (${pct(o.rugRatio)}).` });
  else if (o.rugRatio != null && o.rugRatio >= 0.3)
    flags.push({ severity: "med", code: "rug_risk", message: `Elevated rug risk (${pct(o.rugRatio)}).` });
  if (o.topHolderConcentration != null && o.topHolderConcentration > 0.5)
    flags.push({ severity: "med", code: "holder_concentration", message: `Top-10 hold ${pct(o.topHolderConcentration)}.` });
  if (o.insiderRatio != null && o.insiderRatio > 0.3)
    flags.push({ severity: "med", code: "insider_heavy", message: `Insider/bundler/sniper share ${pct(o.insiderRatio)}.` });
  if (o.lpBurnedOrLocked === false)
    flags.push({ severity: "med", code: "lp_unlocked", message: "Liquidity not burned/locked." });
  if (o.renouncedMint === false)
    flags.push({ severity: "low", code: "mint_not_renounced", message: "Mint authority not renounced." });
  if (o.renouncedFreeze === false)
    flags.push({ severity: "low", code: "freeze_not_renounced", message: "Freeze authority not renounced." });
  const tax = Math.max(o.buyTaxPct ?? 0, o.sellTaxPct ?? 0);
  if (tax > 10) flags.push({ severity: "med", code: "high_tax", message: `High transfer tax (${tax}%).` });
  return flags;
}

/**
 * Deterministic earliness score: young-but-established + small-but-real + microcap.
 * For on-chain token candidates, uses token age + holder distribution + market cap;
 * for account candidates, account age + follower band + market cap.
 */
export function earlinessScore(report: AnalysisReport): number {
  const o = report.onchain;
  const mcap = mcapBandScore(report.price.marketCapUsd);
  if (o) {
    return clampScore(0.4 * tokenAgeScore(o.ageDays) + 0.3 * holderBandScore(o.holderCount) + 0.3 * mcap);
  }
  const age = ageScore(report.account.createdAt);
  const band = followerBandScore(report.profile.followerCount);
  return clampScore(0.4 * age + 0.3 * band + 0.3 * mcap);
}

export function redFlagPenalty(
  flags: RedFlag[],
  penalties: Record<RedFlag["severity"], number> = RED_FLAG_PENALTY,
): number {
  return flags.reduce((sum, f) => sum + (penalties[f.severity] ?? 0), 0);
}

export function toVerdict(
  overall: number,
  thresholds: { high: number; monitor: number } = VERDICT_THRESHOLDS,
): Verdict {
  if (overall >= thresholds.high) return "High";
  if (overall >= thresholds.monitor) return "Monitor";
  return "Avoid";
}

/**
 * Per-signal clamped sub-scores (before weighting). The smart-money / momentum /
 * holder-quality signals BLEND the on-chain and social layers when both are
 * present (a token with a resolved X account), so X analysis always carries
 * weight; they fall back to whichever layer exists. The remaining signals are
 * social (technicalDepth/website/github) or market (price/earliness).
 */
function subScores(report: AnalysisReport): Record<keyof typeof ALPHA_WEIGHTS, number> {
  const o = report.onchain;
  const socialPresent = report.account.userId != null;
  const soc = (v: number): number | null => (socialPresent ? clampScore(v) : null);
  return {
    smartMoney: blendSignal(o ? onchainSmartMoneyScore(o) : null, soc(report.smartMoney.score), BLEND.smartMoney),
    engagement: blendSignal(o ? onchainMomentumScore(o) : null, soc(report.engagement.momentumScore), BLEND.engagement),
    earliness: earlinessScore(report),
    profile: blendSignal(o ? onchainHolderQualityScore(o) : null, soc(report.profile.followerQuality.score), BLEND.profile),
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
export function computeScores(
  report: AnalysisReport,
  profile: ScoringProfile = DEFAULT_PROFILE,
): ScoreBreakdown {
  const s = subScores(report);
  const weighted = (Object.keys(profile.weights) as (keyof typeof ALPHA_WEIGHTS)[]).reduce(
    (sum, k) => sum + profile.weights[k] * s[k],
    0,
  );
  const overall = clampScore(weighted - redFlagPenalty(report.redFlags, profile.penalties));
  return { ...s, overall, verdict: toVerdict(overall, profile.thresholds) };
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
export function explainScore(
  report: AnalysisReport,
  profile: ScoringProfile = DEFAULT_PROFILE,
): ScoreExplanation {
  const s = subScores(report);
  const breakdown = computeScores(report, profile);

  const contributions: ScoreContribution[] = (
    Object.keys(profile.weights) as (keyof typeof ALPHA_WEIGHTS)[]
  )
    .map((key) => ({
      key,
      label: SIGNAL_LABELS[key],
      weight: profile.weights[key],
      score: s[key],
      points: Math.round(profile.weights[key] * s[key] * 10) / 10,
    }))
    .sort((a, b) => b.points - a.points);

  const penalties: ScorePenalty[] = report.redFlags.map((f) => ({
    code: f.code,
    severity: f.severity,
    points: profile.penalties[f.severity] ?? 0,
  }));

  const top = contributions.slice(0, 3).map((c) => c.label.toLowerCase());
  const penaltyTotal = redFlagPenalty(report.redFlags, profile.penalties);
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
