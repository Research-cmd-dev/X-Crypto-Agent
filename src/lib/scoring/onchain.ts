import type { OnChain } from "@/lib/schema/analysis";
import type { TokenSummary, TokenSecurity, TokenTrader } from "@/lib/providers/gmgn/types";

const INSIDER_TAGS = new Set(["insider", "bundler", "sniper"]);

/** Net smart-money flow (USD): bought − sold across smart-money wallets. */
export function smartMoneyNetUsd(traders: TokenTrader[]): number | null {
  const smart = traders.filter((t) => t.tags.includes("smart_degen"));
  if (smart.length === 0) return null;
  return smart.reduce((sum, t) => sum + (t.boughtUsd ?? 0) - (t.soldUsd ?? 0), 0);
}

/** Share of top-trader balance held by insider/bundler/sniper wallets (0..1). */
export function insiderRatio(traders: TokenTrader[]): number | null {
  const total = traders.reduce((s, t) => s + (t.balanceUsd ?? 0), 0);
  if (total <= 0) return null;
  const insider = traders
    .filter((t) => t.tags.some((tag) => INSIDER_TAGS.has(tag)))
    .reduce((s, t) => s + (t.balanceUsd ?? 0), 0);
  return insider / total;
}

/**
 * Assemble the report's `onchain` section from GMGN data. `summary` (from the
 * rank payload) is sufficient on its own; `security` + `traders` enrich it when
 * a candidate is shortlisted for the rate-limited per-token calls.
 */
export function buildOnchain(
  summary: TokenSummary,
  security?: TokenSecurity | null,
  traders?: TokenTrader[],
): OnChain {
  const t = traders ?? [];
  return {
    chain: summary.chain,
    tokenAddress: summary.address,
    launchpad: summary.launchpad,
    ageDays: summary.ageMinutes != null ? summary.ageMinutes / 1440 : null,
    holderCount: summary.holderCount,
    smartMoneyCount: summary.smartMoneyCount,
    smartMoneyNetUsd: smartMoneyNetUsd(t),
    topHolderConcentration: security?.top10HolderRate ?? null,
    insiderRatio: insiderRatio(t),
    liquidityUsd: summary.liquidityUsd,
    rugRatio: security?.rugRatio ?? summary.rugRatio,
    isHoneypot: security?.isHoneypot ?? summary.isHoneypot,
    renouncedMint: security?.renouncedMint ?? null,
    renouncedFreeze: security?.renouncedFreeze ?? null,
    lpBurnedOrLocked: security?.lpBurnedOrLocked ?? null,
    buyTaxPct: security?.buyTaxPct ?? null,
    sellTaxPct: security?.sellTaxPct ?? null,
    priceChange24hPct: summary.priceChange24hPct,
    holderGrowthPct: null, // not in the rank payload; reserved for enrichment
    notes: `On-chain via GMGN (${summary.launchpad ?? "unknown launchpad"}).`,
  };
}

/** A `price` report section derived from a GMGN token summary. */
export function priceFromSummary(summary: TokenSummary) {
  return {
    token: summary.symbol || null,
    marketCapUsd: summary.marketCapUsd,
    volume24hUsd: summary.volume24hUsd,
    priceUsd: summary.priceUsd,
    source: "gmgn",
    notes: `Live on-chain price for ${summary.symbol} (${summary.chain}).`,
  };
}
