// Domain types + provider interface for GMGN (Solana on-chain token data).
// The interface lets the real GMGN API client (`gmgn-api.ts`) be swapped for the
// `mock.ts` provider in tests / offline development — mirroring `providers/x`.

/** A token as it appears in a discovery/rank list or a detail lookup. */
export interface TokenSummary {
  address: string; // contract / mint address
  symbol: string;
  name: string;
  chain: string; // "sol"
  priceUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  holderCount: number | null;
  /** Tracked smart-money wallets holding (GMGN `smart_degen_count`). */
  smartMoneyCount: number | null;
  priceChange24hPct: number | null;
  /** GMGN rug risk, 0..1. */
  rugRatio: number | null;
  isHoneypot: boolean | null;
  /** Dev/team hold share, 0..1. */
  devHoldRate: number | null;
  launchpad: string | null; // pump_fun, raydium, letsbonk, ...
  ageMinutes: number | null;
  /** Socials (populated by tokenInfo; null in rank lists). */
  twitter: string | null;
  website: string | null;
}

/** Per-token security / risk metrics (GMGN `/token/security`). */
export interface TokenSecurity {
  address: string;
  renouncedMint: boolean | null;
  renouncedFreeze: boolean | null;
  lpBurnedOrLocked: boolean | null;
  top10HolderRate: number | null; // 0..1
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  rugRatio: number | null; // 0..1
  isHoneypot: boolean | null;
}

export type WalletTag =
  | "smart_degen"
  | "insider"
  | "bundler"
  | "sniper"
  | "whale"
  | "fresh"
  | "kol";

/** A top holder/trader of a token, with wallet classification + flows. */
export interface TokenTrader {
  wallet: string;
  tags: WalletTag[];
  realizedPnlUsd: number | null;
  balanceUsd: number | null;
  buyCount: number | null;
  sellCount: number | null;
  boughtUsd: number | null;
  soldUsd: number | null;
}

export interface TrendingOptions {
  chain?: string; // default "sol"
  interval?: "1m" | "5m" | "1h" | "6h" | "24h";
  orderBy?: "smart_degen_count" | "volume" | "marketcap" | "swaps" | "holder_count";
  limit?: number;
  /** Launchpad filter, e.g. ["pump_fun", "raydium"]. */
  platforms?: string[];
}

export interface GmgnProvider {
  /** Trending tokens (the primary discovery funnel). */
  trending(opts?: TrendingOptions): Promise<TokenSummary[]>;
  /** Newly-launched tokens (trenches / new_creation). */
  newLaunches(opts?: TrendingOptions): Promise<TokenSummary[]>;
  /** Per-token detail incl. socials. */
  tokenInfo(address: string, chain?: string): Promise<TokenSummary | null>;
  /** Per-token security / risk metrics. */
  tokenSecurity(address: string, chain?: string): Promise<TokenSecurity | null>;
  /** Top holders/traders with wallet classification. */
  topTraders(address: string, chain?: string): Promise<TokenTrader[]>;
}
