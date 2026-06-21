import { cached } from "@/lib/cache/store";
import { fetchWithRetry } from "@/lib/util/fetch";
import type { PriceHistoryProvider, PriceSnapshot } from "@/lib/providers/price";
import type { HistorySeriesSource, PricePoint } from "@/lib/providers/token-history";

const ENDPOINT = "https://streaming.bitquery.io/eapi";
const DAY_MS = 86_400_000;

// Hourly OHLC buckets over a range: close price (last trade in the hour) + USD volume.
const RANGE_QUERY = `query ($mint: String!, $since: DateTime!, $till: DateTime!) {
  Solana(dataset: combined) {
    DEXTradeByTokens(
      orderBy: { ascending: Block_Time }
      where: {
        Trade: { Currency: { MintAddress: { is: $mint } } }
        Block: { Time: { since: $since, till: $till } }
      }
    ) {
      Block { Time(interval: { in: hours, count: 1 }) }
      Trade { close: PriceInUSD(maximum: Block_Time) }
      volume: sum(of: Trade_AmountInUSD)
    }
  }
}`;

function isoDay(date: Date): { since: string; till: string } {
  const start = new Date(Math.floor(date.getTime() / DAY_MS) * DAY_MS);
  return { since: start.toISOString(), till: new Date(start.getTime() + DAY_MS).toISOString() };
}

/**
 * GraphQL: the day's DEX trades for a token, newest first (so the first row's
 * price is the day's close) with the USD-volume sum. Public `combined` dataset
 * covers ~May 2024 onward and indexes DEX swaps directly, so it reaches obscure
 * memecoins Birdeye doesn't list.
 */
const QUERY = `query ($mint: String!, $since: DateTime!, $till: DateTime!) {
  Solana(dataset: combined) {
    DEXTradeByTokens(
      orderBy: { descending: Block_Time }
      where: {
        Trade: { Currency: { MintAddress: { is: $mint } } }
        Block: { Time: { since: $since, till: $till } }
      }
    ) {
      Trade { Price PriceInUSD }
      volume: sum(of: Trade_AmountInUSD)
    }
  }
}`;

/**
 * Historical Solana price + volume via Bitquery, used as a fallback behind Birdeye
 * (see {@link FallbackPriceHistory}) for tokens/dates Birdeye doesn't cover. Ids
 * ARE the mint address. History is immutable → cached long. Needs BITQUERY_API_KEY.
 */
export class BitqueryPriceHistory implements PriceHistoryProvider, HistorySeriesSource {
  private readonly key?: string;

  constructor(key = process.env.BITQUERY_API_KEY) {
    this.key = key;
  }

  /** Mint address — nothing to resolve. */
  async resolve(query: string): Promise<string | null> {
    return query || null;
  }

  async historyOn(mint: string, date: Date): Promise<PriceSnapshot | null> {
    if (!this.key) return null;
    const { since, till } = isoDay(date);
    return cached("price:bitquery-history", `${mint}:${since}`, 2_592_000, async () => {
      const res = await fetchWithRetry(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
        body: JSON.stringify({ query: QUERY, variables: { mint, since, till } }),
      }).catch(() => null);
      if (!res || !res.ok) return null;
      const body = (await res.json()) as {
        data?: {
          Solana?: {
            DEXTradeByTokens?: Array<{
              Trade?: { Price?: number; PriceInUSD?: number };
              volume?: number | string;
            }>;
          } | null;
        };
      };
      const row = body.data?.Solana?.DEXTradeByTokens?.[0];
      const priceUsd = row?.Trade?.PriceInUSD ?? row?.Trade?.Price ?? null;
      if (priceUsd == null) return null;
      const vol = row?.volume == null ? null : Number(row.volume);
      return {
        priceUsd,
        marketCapUsd: null,
        volume24hUsd: vol != null && Number.isFinite(vol) ? vol : null,
      };
    });
  }

  /** Hourly price+volume series over [from, to] (one aggregated query). */
  async historyRange(mint: string, from: Date, to: Date): Promise<PricePoint[]> {
    if (!this.key) return [];
    const since = from.toISOString();
    const till = to.toISOString();
    return cached("price:bitquery-ohlcv-1h", `${mint}:${since}:${till}`, 2_592_000, async () => {
      const res = await fetchWithRetry(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
        body: JSON.stringify({ query: RANGE_QUERY, variables: { mint, since, till } }),
      }).catch(() => null);
      if (!res || !res.ok) return [];
      const body = (await res.json()) as {
        data?: {
          Solana?: {
            DEXTradeByTokens?: Array<{
              Block?: { Time?: string };
              Trade?: { close?: number };
              volume?: number | string;
            }>;
          } | null;
        };
      };
      const rows = body.data?.Solana?.DEXTradeByTokens ?? [];
      return rows
        .filter((r) => r.Trade?.close != null && r.Block?.Time)
        .map((r) => {
          const vol = r.volume == null ? null : Number(r.volume);
          return {
            at: new Date(r.Block!.Time as string),
            priceUsd: r.Trade!.close as number,
            volumeUsd: vol != null && Number.isFinite(vol) ? vol : null,
            source: "bitquery",
          };
        });
    });
  }
}
