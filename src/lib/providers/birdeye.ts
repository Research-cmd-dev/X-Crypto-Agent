import { cached } from "@/lib/cache/store";
import { fetchWithRetry } from "@/lib/util/fetch";
import type { PriceHistoryProvider, PriceSnapshot } from "@/lib/providers/price";

const BASE = "https://public-api.birdeye.so";

/** Whole-second UNIX timestamp for a date (Birdeye keys history by unixtime). */
export function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Historical Solana token prices via Birdeye, for backtesting memecoins that
 * CoinGecko does not index. Implements {@link PriceHistoryProvider}: ids ARE the
 * token mint address (resolution is a pass-through). History is immutable, so
 * results are cached long. Requires BIRDEYE_API_KEY; free tier is rate-limited,
 * so callers should throttle.
 *
 * NOTE: the by-timestamp endpoint returns spot price only; market cap / volume
 * at that instant are not provided, so the snapshot carries price and leaves
 * mcap/volume null. Forward returns are computed from price (see `forwardReturn`).
 */
export class BirdeyePriceHistory implements PriceHistoryProvider {
  private readonly key?: string;

  constructor(key = process.env.BIRDEYE_API_KEY) {
    this.key = key;
  }

  private headers(): HeadersInit {
    return {
      "x-chain": "solana",
      ...(this.key ? { "X-API-KEY": this.key } : {}),
    };
  }

  /** Birdeye is keyed by mint address — nothing to resolve. */
  async resolve(query: string): Promise<string | null> {
    return query || null;
  }

  async historyOn(mint: string, date: Date): Promise<PriceSnapshot | null> {
    const unixtime = toUnixSeconds(date);
    return cached("price:birdeye-history", `${mint}:${unixtime}`, 2_592_000, async () => {
      const url = `${BASE}/defi/history_price_by_timestamp?address=${encodeURIComponent(mint)}&timestamp=${unixtime}`;
      const res = await fetchWithRetry(url, { headers: this.headers() }).catch(() => null);
      if (!res || !res.ok) return null;
      const body = (await res.json()) as {
        success?: boolean;
        data?: { value?: number; price?: number } | null;
      };
      const value = body.data?.value ?? body.data?.price ?? null;
      if (value == null) return null;
      return { priceUsd: value, marketCapUsd: null, volume24hUsd: null };
    });
  }
}
