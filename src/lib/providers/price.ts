import { cached } from "@/lib/cache/store";
import { fetchWithRetry } from "@/lib/util/fetch";

export interface PriceData {
  token: string | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  priceUsd: number | null;
  source: string;
  notes: string;
}

const EMPTY: PriceData = {
  token: null,
  marketCapUsd: null,
  volume24hUsd: null,
  priceUsd: null,
  source: "none",
  notes: "No token / price data found.",
};

/**
 * Resolves token market data. Tries CoinGecko search→market first (by name or
 * symbol), then falls back to DexScreener (by symbol). Returns a neutral empty
 * result if nothing matches — many early projects have no token yet.
 */
export class PriceProvider {
  private readonly cgKey?: string;

  constructor(cgKey = process.env.COINGECKO_API_KEY) {
    this.cgKey = cgKey;
  }

  private cgHeaders(): HeadersInit {
    return this.cgKey ? { "x-cg-pro-api-key": this.cgKey } : {};
  }

  private cgBase(): string {
    return this.cgKey ? "https://pro-api.coingecko.com/api/v3" : "https://api.coingecko.com/api/v3";
  }

  async lookup(query: string): Promise<PriceData> {
    // Cache 5 min — prices move, but discovery/analysis can repeat a query.
    return cached("price:lookup", query.toLowerCase(), 300, async () => {
      const cg = await this.tryCoinGecko(query).catch(() => null);
      if (cg) return cg;
      const dx = await this.tryDexScreener(query).catch(() => null);
      if (dx) return dx;
      return { ...EMPTY };
    });
  }

  private async tryCoinGecko(query: string): Promise<PriceData | null> {
    const searchRes = await fetchWithRetry(
      `${this.cgBase()}/search?query=${encodeURIComponent(query)}`,
      { headers: this.cgHeaders() },
    );
    if (!searchRes.ok) return null;
    const search = (await searchRes.json()) as {
      coins?: { id: string; symbol: string }[];
    };
    const coin = search.coins?.[0];
    if (!coin) return null;

    const mktRes = await fetchWithRetry(
      `${this.cgBase()}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(coin.id)}`,
      { headers: this.cgHeaders() },
    );
    if (!mktRes.ok) return null;
    const markets = (await mktRes.json()) as {
      current_price?: number;
      market_cap?: number;
      total_volume?: number;
    }[];
    const m = markets[0];
    if (!m) return null;

    return {
      token: coin.symbol.toUpperCase(),
      marketCapUsd: m.market_cap ?? null,
      volume24hUsd: m.total_volume ?? null,
      priceUsd: m.current_price ?? null,
      source: "coingecko",
      notes: `Matched CoinGecko id '${coin.id}'.`,
    };
  }

  private async tryDexScreener(query: string): Promise<PriceData | null> {
    const res = await fetchWithRetry(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      pairs?: {
        baseToken?: { symbol?: string };
        priceUsd?: string;
        fdv?: number;
        marketCap?: number;
        volume?: { h24?: number };
      }[];
    };
    const pair = data.pairs?.[0];
    if (!pair) return null;

    return {
      token: pair.baseToken?.symbol?.toUpperCase() ?? null,
      marketCapUsd: pair.marketCap ?? pair.fdv ?? null,
      volume24hUsd: pair.volume?.h24 ?? null,
      priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
      source: "dexscreener",
      notes: "Matched via DexScreener pair search.",
    };
  }
}
