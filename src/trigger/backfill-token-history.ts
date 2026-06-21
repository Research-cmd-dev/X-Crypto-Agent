import { task, logger } from "@trigger.dev/sdk/v3";
import { supabaseServer } from "@/lib/supabase/server";
import { BirdeyePriceHistory } from "@/lib/providers/birdeye";
import { BitqueryPriceHistory } from "@/lib/providers/bitquery";
import { fetchTokenSeries, type HistorySeriesSource } from "@/lib/providers/token-history";

const DAY_MS = 86_400_000;
const DEFAULT_LOOKBACK_DAYS = 180;

export interface TokenHistoryInput {
  chain: string;
  tokenAddress: string;
  lookbackDays?: number;
}

export interface TokenPriceRow {
  chain: string;
  token_address: string;
  observed_at: string;
  price_usd: number;
  volume_usd: number | null;
  mcap_usd: number | null;
  source: string;
}

/** Injected so the core is unit-testable without live APIs or a DB. */
export interface TokenHistoryDeps {
  sources: HistorySeriesSource[];
  /** True if the token already has rows recently (avoid re-backfilling). */
  recentlyBackfilled(chain: string, tokenAddress: string): Promise<boolean>;
  upsert(rows: TokenPriceRow[]): Promise<number>;
  now?: () => number;
}

/**
 * Backfill a token's hourly price+volume series since launch (capped at
 * `lookbackDays`) into `token_price_history`. Skips when recently backfilled;
 * upsert keeps re-fires idempotent. Pure orchestration over injected deps.
 */
export async function runTokenHistoryBackfill(
  input: TokenHistoryInput,
  deps: TokenHistoryDeps,
): Promise<{ inserted: number; skipped: boolean }> {
  if (await deps.recentlyBackfilled(input.chain, input.tokenAddress)) {
    return { inserted: 0, skipped: true };
  }
  const now = deps.now?.() ?? Date.now();
  const to = new Date(now);
  const from = new Date(now - (input.lookbackDays ?? DEFAULT_LOOKBACK_DAYS) * DAY_MS);

  const points = await fetchTokenSeries(input.tokenAddress, from, to, deps.sources);
  if (points.length === 0) return { inserted: 0, skipped: false };

  const rows: TokenPriceRow[] = points.map((p) => ({
    chain: input.chain,
    token_address: input.tokenAddress,
    observed_at: p.at.toISOString(),
    price_usd: p.priceUsd,
    volume_usd: p.volumeUsd,
    mcap_usd: null,
    source: p.source,
  }));
  const inserted = await deps.upsert(rows);
  return { inserted, skipped: false };
}

function defaultDeps(): TokenHistoryDeps {
  const sb = supabaseServer();
  return {
    sources: [new BirdeyePriceHistory(), new BitqueryPriceHistory()],
    async recentlyBackfilled(chain, tokenAddress) {
      const since = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
      const { data } = await sb
        .from("token_price_history")
        .select("id")
        .eq("chain", chain)
        .eq("token_address", tokenAddress)
        .gte("observed_at", since)
        .limit(1);
      return (data?.length ?? 0) > 0;
    },
    async upsert(rows) {
      let n = 0;
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { error } = await sb
          .from("token_price_history")
          .upsert(chunk, { onConflict: "chain,token_address,observed_at", ignoreDuplicates: true });
        if (error) {
          logger.warn("token_price_history upsert failed", { error: error.message });
          continue;
        }
        n += chunk.length;
      }
      return n;
    },
  };
}

/** Backfill a token's price/volume history. Fired when a token is flagged. */
export const backfillTokenHistoryTask = task({
  id: "backfill-token-history",
  maxDuration: 600,
  queue: { concurrencyLimit: 2 },
  run: async (payload: TokenHistoryInput) => runTokenHistoryBackfill(payload, defaultDeps()),
});
