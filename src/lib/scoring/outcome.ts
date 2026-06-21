/**
 * Pure forward-return math for outcome tracking. Kept free of any DB / Trigger.dev
 * imports so it is trivially unit-testable and reusable by the scheduled job.
 */

/** Days after which a tracked outcome's forward return is frozen as ground truth. */
export const MATURITY_DAYS = 30;

/**
 * Forward return vs. the entry baseline. Prefers price-on-both (most precise);
 * falls back to market-cap-on-both when a price is missing on either side.
 * Returns null when neither pair is comparable.
 */
export function forwardReturn(
  baselinePrice: number | null,
  baselineMcap: number | null,
  currentPrice: number | null,
  currentMcap: number | null,
): number | null {
  if (baselinePrice != null && currentPrice != null && baselinePrice > 0) {
    return currentPrice / baselinePrice - 1;
  }
  if (baselineMcap != null && currentMcap != null && baselineMcap > 0) {
    return currentMcap / baselineMcap - 1;
  }
  return null;
}

/** Whole days elapsed since the baseline observation. */
export function horizonDays(baselineAt: string, now: number = Date.now()): number {
  return Math.floor((now - new Date(baselineAt).getTime()) / 86_400_000);
}

export function isMatured(days: number): boolean {
  return days >= MATURITY_DAYS;
}
