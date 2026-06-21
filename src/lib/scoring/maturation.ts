import type { GmgnProvider } from "@/lib/providers/gmgn";
import type { OutcomeRow } from "@/lib/supabase/types";

/** Minimal price interface so maturation is testable with a mock. */
export interface PriceLookup {
  lookup(query: string): Promise<{ priceUsd: number | null; marketCapUsd: number | null }>;
}

export interface CurrentPrice {
  priceUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
}

/** Price sources for maturation: CoinGecko (by symbol) + GMGN (by mint). */
export interface MaturationSources {
  coingecko: PriceLookup;
  gmgn: GmgnProvider;
}

/**
 * Route the current-price lookup by candidate type: on-chain tokens (a mint +
 * chain) re-price via GMGN — memecoins aren't on CoinGecko by symbol — while
 * everything else uses CoinGecko. This is what lets the live label loop actually
 * close for the Solana tokens the scout now targets.
 */
export async function currentPriceForOutcome(
  o: Pick<OutcomeRow, "token_ref" | "token_address" | "chain">,
  sources: MaturationSources,
): Promise<CurrentPrice> {
  if (o.token_address) {
    const s = await sources.gmgn.tokenInfo(o.token_address, o.chain ?? "sol");
    return s
      ? { priceUsd: s.priceUsd, marketCapUsd: s.marketCapUsd, volume24hUsd: s.volume24hUsd }
      : { priceUsd: null, marketCapUsd: null, volume24hUsd: null };
  }
  if (!o.token_ref) return { priceUsd: null, marketCapUsd: null, volume24hUsd: null };
  const c = await sources.coingecko.lookup(o.token_ref);
  return { priceUsd: c.priceUsd, marketCapUsd: c.marketCapUsd, volume24hUsd: null };
}
