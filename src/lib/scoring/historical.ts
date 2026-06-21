import type { AnalysisReport } from "@/lib/schema/analysis";
import type { PriceSnapshot } from "@/lib/providers/price";
import { emptyReport } from "@/lib/orchestrator/graph";

/**
 * Signals a price/fundamentals historical sample legitimately measures. The X
 * social graph isn't time-travelable, so smart money / engagement / follower
 * quality CANNOT be reconstructed for a past date and are left neutral. A
 * historical backtest must only tune the weights of THESE signals (see
 * `searchWeights({ tunableKeys })`) so the optimizer never zeroes out the
 * unmeasured social weights.
 */
export const MEASURED_SIGNALS = ["earliness", "price"] as const;

export interface HistoricalInput {
  handle: string;
  /** Token ticker/symbol (for the report's price.token + outcome token_ref). */
  token: string | null;
  /** Account creation date (immutable) — drives the age part of earliness. */
  createdAt: string | null;
}

/**
 * Build a Zod-valid AnalysisReport reflecting a project's state AT a past entry
 * date, using only reconstructable data: account age (immutable createdAt) and
 * the token's price/market-cap/volume on that date. All social fields stay at
 * the neutral baseline — they are explicitly unmeasured. `earlinessScore` then
 * computes faithfully from age-at-T + mcap-at-T (the follower-band term is
 * neutral since followerCount is null) and `priceContextScore` from the T price.
 */
export function buildHistoricalReport(
  input: HistoricalInput,
  priceAtT: PriceSnapshot,
): AnalysisReport {
  const report = emptyReport(input.handle);
  report.account.createdAt = input.createdAt;
  report.price = {
    token: input.token,
    priceUsd: priceAtT.priceUsd,
    marketCapUsd: priceAtT.marketCapUsd,
    volume24hUsd: priceAtT.volume24hUsd,
    source: "coingecko-history",
    notes: "Historical backfill: price/mcap as of the entry date.",
  };
  report.summary =
    "Historical backfill sample (price/fundamentals only; social signals not reconstructable).";
  return report;
}
