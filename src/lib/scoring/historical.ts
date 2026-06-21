import type { AnalysisReport } from "@/lib/schema/analysis";
import type { PriceSnapshot } from "@/lib/providers/price";
import { emptyReport } from "@/lib/orchestrator/graph";

/**
 * Signals a price/fundamentals historical sample legitimately measures. Neither
 * the X social graph nor on-chain smart-money is deeply time-travelable, so those
 * are left neutral and a historical backtest must only tune the weights of THESE
 * signals (see `searchWeights({ tunableKeys })`) so the optimizer never zeroes out
 * the unmeasured weights.
 */
export const MEASURED_SIGNALS = ["earliness", "price"] as const;

/** Fields used to choose a historical price source for a curated entry. */
export interface HistoricalEntrySource {
  coingeckoId?: string;
  tokenAddress?: string;
  chain?: string;
}

/**
 * Pick the historical price source for a curated entry: Birdeye for Solana mints
 * (which CoinGecko usually doesn't index), CoinGecko otherwise.
 */
export function historySourceKind(e: HistoricalEntrySource): "birdeye" | "coingecko" {
  if (e.chain?.toLowerCase() === "sol") return "birdeye";
  if (e.tokenAddress && !e.coingeckoId) return "birdeye";
  return "coingecko";
}

/** Estimate market cap from spot price × supply (memecoin supply is ~fixed). */
export function estimateMcap(priceUsd: number | null, totalSupply: number | null | undefined): number | null {
  if (priceUsd == null || totalSupply == null) return null;
  return priceUsd * totalSupply;
}

export interface HistoricalInput {
  handle: string;
  /** Token ticker/symbol (for the report's price.token + outcome token_ref). */
  token: string | null;
  /** Account creation date (immutable) — drives the age part of earliness for social entries. */
  createdAt: string | null;
  /** Where the price came from (e.g. "coingecko-history", "birdeye-history"). */
  source?: string;
  /** On-chain (Solana token) context — drives token-age earliness when present. */
  onchain?: { chain: string; tokenAddress: string; ageDays: number | null };
}

/**
 * Build a Zod-valid AnalysisReport reflecting a project's state AT a past entry
 * date, using only reconstructable data. For social entries: account age (immutable
 * createdAt) + price/mcap-at-T. For on-chain (Solana) entries: token age + price/
 * mcap-at-T (smart-money / holders at T are NOT reconstructable → left neutral).
 * `earlinessScore` and `priceContextScore` then read the real T data.
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
    source: input.source ?? "coingecko-history",
    notes: "Historical backfill: price/mcap as of the entry date.",
  };
  if (input.onchain) {
    report.onchain = {
      chain: input.onchain.chain,
      tokenAddress: input.onchain.tokenAddress,
      launchpad: null,
      ageDays: input.onchain.ageDays,
      holderCount: null,
      smartMoneyCount: null,
      smartMoneyNetUsd: null,
      topHolderConcentration: null,
      insiderRatio: null,
      liquidityUsd: priceAtT.volume24hUsd,
      rugRatio: null,
      isHoneypot: null,
      renouncedMint: null,
      renouncedFreeze: null,
      lpBurnedOrLocked: null,
      buyTaxPct: null,
      sellTaxPct: null,
      priceChange24hPct: null,
      holderGrowthPct: null,
      notes: "Historical: on-chain risk/smart-money at T not reconstructable (price + age only).",
    };
  }
  report.summary =
    "Historical backfill sample (price/fundamentals only; social + on-chain risk signals not reconstructable).";
  return report;
}
