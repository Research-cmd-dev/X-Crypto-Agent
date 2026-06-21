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
 * `historyOn` prefers the OHLCV endpoint (a daily candle covering the date), which
 * yields close price AND volume; it falls back to the by-timestamp endpoint (spot
 * price only) when OHLCV has no candle. Market cap is never returned (estimate it
 * from supply downstream). For deeper / obscure-token coverage, wrap this in
 * {@link FallbackPriceHistory} with a Bitquery source behind it.
 */
const DAY_SECONDS = 86_400;

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
      return (await this.ohlcvOn(mint, unixtime)) ?? (await this.priceOn(mint, unixtime));
    });
  }

  /** Daily OHLCV candle covering the date → close price + volume. */
  private async ohlcvOn(mint: string, unixtime: number): Promise<PriceSnapshot | null> {
    const url =
      `${BASE}/defi/ohlcv?address=${encodeURIComponent(mint)}&type=1D` +
      `&time_from=${unixtime}&time_to=${unixtime + DAY_SECONDS}`;
    const res = await fetchWithRetry(url, { headers: this.headers() }).catch(() => null);
    if (!res || !res.ok) return null;
    const body = (await res.json()) as {
      data?: { items?: Array<{ c?: number; v?: number }> } | null;
    };
    const candle = body.data?.items?.[0];
    if (!candle || candle.c == null) return null;
    return { priceUsd: candle.c, marketCapUsd: null, volume24hUsd: candle.v ?? null };
  }

  /** Spot price at the timestamp (no volume) — fallback when OHLCV is empty. */
  private async priceOn(mint: string, unixtime: number): Promise<PriceSnapshot | null> {
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
  }
}
