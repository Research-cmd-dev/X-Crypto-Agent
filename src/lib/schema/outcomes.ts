/**
 * Outcome labels for pump.fun launch calibration.
 *
 * Pure math: given prices (or mcaps) at graduation and later horizons,
 * compute returns and a simple success flag used to evaluate launchScore.
 * No I/O — backfill scripts supply the prices from Birdeye/ST/etc.
 */

export const OUTCOME_HORIZONS_HOURS = [1, 6, 24] as const;
export type OutcomeHorizonHours = (typeof OUTCOME_HORIZONS_HOURS)[number];

export interface OutcomeConfig {
  /** Max drawdown from T0 price that still counts as success at 24h (e.g. -0.9 = −90%). */
  maxDrawdownSuccess24h: number;
  /** Min return at 24h for "strong success" bucket. */
  strongReturn24h: number;
}

export const DEFAULT_OUTCOME: OutcomeConfig = {
  maxDrawdownSuccess24h: -0.9,
  strongReturn24h: 0.5, // +50%
};

export interface PricePoint {
  /** Unix ms or ISO; optional for display. */
  at?: string | number | null;
  priceUsd: number | null;
  marketCapUsd?: number | null;
  volumeUsd?: number | null;
  liquidityUsd?: number | null;
  source?: string;
}

export interface LaunchOutcome {
  /** (p_t / p0) - 1 ; null if either price missing or p0 <= 0 */
  ret1h: number | null;
  ret6h: number | null;
  ret24h: number | null;
  /** Still "alive enough" at 24h: not catastrophic dump (configurable). */
  success24h: boolean | null;
  /** ret24h >= strongReturn24h */
  strong24h: boolean | null;
  /** Best available label for tables */
  label: "unknown" | "rugged" | "weak" | "ok" | "strong";
}

/** Simple return; null if invalid. */
export function priceReturn(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from == null || to == null || !(from > 0) || !Number.isFinite(from) || !Number.isFinite(to)) {
    return null;
  }
  return (to - from) / from;
}

/**
 * Pick the candle closest to targetUnixSec within maxDeltaSec (default 45 min for 1h series).
 * Candles: { unixTime: seconds, c: close }.
 */
export function closeNear(
  candles: Array<{ unixTime: number; c: number }>,
  targetUnixSec: number,
  maxDeltaSec = 45 * 60,
): number | null {
  if (!candles.length) return null;
  let best: { c: number; d: number } | null = null;
  for (const k of candles) {
    if (k.c == null || !Number.isFinite(k.c)) continue;
    const d = Math.abs(k.unixTime - targetUnixSec);
    if (d > maxDeltaSec) continue;
    if (!best || d < best.d) best = { c: k.c, d };
  }
  return best?.c ?? null;
}

export function computeOutcome(
  t0: PricePoint,
  later: { h1?: PricePoint | null; h6?: PricePoint | null; h24?: PricePoint | null },
  cfg: OutcomeConfig = DEFAULT_OUTCOME,
): LaunchOutcome {
  const p0 = t0.priceUsd ?? null;
  const ret1h = priceReturn(p0, later.h1?.priceUsd);
  const ret6h = priceReturn(p0, later.h6?.priceUsd);
  const ret24h = priceReturn(p0, later.h24?.priceUsd);

  let success24h: boolean | null = null;
  let strong24h: boolean | null = null;
  if (ret24h != null) {
    success24h = ret24h > cfg.maxDrawdownSuccess24h;
    strong24h = ret24h >= cfg.strongReturn24h;
  }

  let label: LaunchOutcome["label"] = "unknown";
  if (ret24h != null) {
    if (ret24h <= cfg.maxDrawdownSuccess24h) label = "rugged";
    else if (ret24h >= cfg.strongReturn24h) label = "strong";
    else if (ret24h >= 0) label = "ok";
    else label = "weak";
  }

  return { ret1h, ret6h, ret24h, success24h, strong24h, label };
}

/** Summarize how well launchScore separates strong vs rugged (offline eval). */
export function scoreDiscrimination(
  rows: Array<{ launchScore: number; label: LaunchOutcome["label"] }>,
): { n: number; highAvgScore: number | null; ruggedAvgScore: number | null; gap: number | null } {
  const high = rows.filter((r) => r.label === "strong" || r.label === "ok");
  const rugged = rows.filter((r) => r.label === "rugged");
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const highAvgScore = avg(high.map((r) => r.launchScore));
  const ruggedAvgScore = avg(rugged.map((r) => r.launchScore));
  const gap =
    highAvgScore != null && ruggedAvgScore != null ? highAvgScore - ruggedAvgScore : null;
  return { n: rows.length, highAvgScore, ruggedAvgScore, gap };
}

export function formatPct(ret: number | null): string {
  if (ret == null) return "?";
  const pct = ret * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}
