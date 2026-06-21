import type {
  GmgnProvider,
  TokenSummary,
  TokenSecurity,
  TokenTrader,
  TrendingOptions,
} from "@/lib/providers/gmgn/types";

/**
 * Deterministic GMGN fixtures for offline development + tests. Three archetypes:
 *  - GEM: smart-money microcap, clean security (the target).
 *  - RUG: honeypot, high concentration, mint not renounced (should score Avoid).
 *  - DUD: real but thin liquidity, no smart money (Monitor/Avoid).
 */
const GEM: TokenSummary = {
  address: "GeMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  symbol: "GEM",
  name: "Gem Coin",
  chain: "sol",
  priceUsd: 0.0021,
  marketCapUsd: 2_100_000,
  volume24hUsd: 420_000,
  liquidityUsd: 180_000,
  holderCount: 1_200,
  smartMoneyCount: 9,
  priceChange24hPct: 60,
  rugRatio: 0.05,
  isHoneypot: false,
  devHoldRate: 0.02,
  launchpad: "pump_fun",
  ageMinutes: 60 * 24 * 12, // ~12 days
  migratedAt: Math.floor(Date.now() / 1000) - 600, // migrated ~10 min ago
  twitter: "https://x.com/gemcoin",
  website: "https://gemcoin.xyz",
};

const RUG: TokenSummary = {
  address: "RuGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  symbol: "RUG",
  name: "Rug Pull",
  chain: "sol",
  priceUsd: 0.0008,
  marketCapUsd: 900_000,
  volume24hUsd: 700_000,
  liquidityUsd: 25_000,
  holderCount: 320,
  smartMoneyCount: 0,
  priceChange24hPct: 180,
  rugRatio: 0.72,
  isHoneypot: true,
  devHoldRate: 0.35,
  launchpad: "pump_fun",
  ageMinutes: 60 * 6, // 6 hours
  migratedAt: Math.floor(Date.now() / 1000) - 300, // migrated ~5 min ago
  twitter: null,
  website: null,
};

const DUD: TokenSummary = {
  address: "DuDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  symbol: "DUD",
  name: "Dud Token",
  chain: "sol",
  priceUsd: 0.0005,
  marketCapUsd: 6_000_000,
  volume24hUsd: 9_000,
  liquidityUsd: 40_000,
  holderCount: 5_400,
  smartMoneyCount: 1,
  priceChange24hPct: -8,
  rugRatio: 0.12,
  isHoneypot: false,
  devHoldRate: 0.04,
  launchpad: "raydium",
  ageMinutes: 60 * 24 * 200, // ~200 days
  migratedAt: null, // old token, not a recent migration
  twitter: "https://x.com/dudtoken",
  website: null,
};

const BY_ADDRESS = new Map<string, TokenSummary>([GEM, RUG, DUD].map((t) => [t.address, t]));

const SECURITY: Record<string, TokenSecurity> = {
  [GEM.address]: {
    address: GEM.address,
    renouncedMint: true,
    renouncedFreeze: true,
    lpBurnedOrLocked: true,
    top10HolderRate: 0.22,
    buyTaxPct: 0,
    sellTaxPct: 0,
    rugRatio: 0.05,
    isHoneypot: false,
  },
  [RUG.address]: {
    address: RUG.address,
    renouncedMint: false,
    renouncedFreeze: false,
    lpBurnedOrLocked: false,
    top10HolderRate: 0.78,
    buyTaxPct: 8,
    sellTaxPct: 25,
    rugRatio: 0.72,
    isHoneypot: true,
  },
  [DUD.address]: {
    address: DUD.address,
    renouncedMint: true,
    renouncedFreeze: true,
    lpBurnedOrLocked: true,
    top10HolderRate: 0.31,
    buyTaxPct: 0,
    sellTaxPct: 0,
    rugRatio: 0.12,
    isHoneypot: false,
  },
};

const TRADERS: Record<string, TokenTrader[]> = {
  [GEM.address]: [
    { wallet: "smart1", tags: ["smart_degen", "kol"], realizedPnlUsd: 120_000, balanceUsd: 30_000, buyCount: 3, sellCount: 0, boughtUsd: 30_000, soldUsd: 0 },
    { wallet: "smart2", tags: ["smart_degen"], realizedPnlUsd: 80_000, balanceUsd: 18_000, buyCount: 2, sellCount: 0, boughtUsd: 18_000, soldUsd: 0 },
    { wallet: "whale1", tags: ["whale"], realizedPnlUsd: 5_000, balanceUsd: 50_000, buyCount: 1, sellCount: 0, boughtUsd: 50_000, soldUsd: 0 },
  ],
  [RUG.address]: [
    { wallet: "ins1", tags: ["insider", "bundler"], realizedPnlUsd: 200_000, balanceUsd: 90_000, buyCount: 5, sellCount: 4, boughtUsd: 10_000, soldUsd: 210_000 },
    { wallet: "snipe1", tags: ["sniper"], realizedPnlUsd: 60_000, balanceUsd: 40_000, buyCount: 1, sellCount: 1, boughtUsd: 2_000, soldUsd: 62_000 },
  ],
  [DUD.address]: [
    { wallet: "fresh1", tags: ["fresh"], realizedPnlUsd: -2_000, balanceUsd: 1_000, buyCount: 1, sellCount: 0, boughtUsd: 3_000, soldUsd: 0 },
  ],
};

export class MockGmgnProvider implements GmgnProvider {
  async trending(opts: TrendingOptions = {}): Promise<TokenSummary[]> {
    const all = [GEM, DUD, RUG];
    return all.slice(0, opts.limit ?? all.length);
  }

  async newLaunches(): Promise<TokenSummary[]> {
    return [GEM, RUG];
  }

  /** A clean migrated gem (with X) + a freshly-migrated rug (no X). */
  async recentMigrations(): Promise<TokenSummary[]> {
    return [GEM, RUG];
  }

  async tokenInfo(address: string): Promise<TokenSummary | null> {
    return BY_ADDRESS.get(address) ?? null;
  }

  async tokenSecurity(address: string): Promise<TokenSecurity | null> {
    return SECURITY[address] ?? null;
  }

  async topTraders(address: string): Promise<TokenTrader[]> {
    return TRADERS[address] ?? [];
  }
}

/** Fixture addresses, exported so tests can reference the archetypes by name. */
export const MOCK_TOKENS = { GEM, RUG, DUD };
