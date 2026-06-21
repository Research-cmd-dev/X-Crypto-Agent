import { cached } from "@/lib/cache/store";
import { fetchWithRetry } from "@/lib/util/fetch";
import type { PriceHistoryProvider, PriceSnapshot } from "@/lib/providers/price";

const ENDPOINT = "https://streaming.bitquery.io/eapi";
const DAY_MS = 86_400_000;

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
export class BitqueryPriceHistory implements PriceHistoryProvider {
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
}
