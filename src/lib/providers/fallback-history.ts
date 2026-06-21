import type { PriceHistoryProvider, PriceSnapshot } from "@/lib/providers/price";

/**
 * Tries an ordered list of {@link PriceHistoryProvider}s and returns the first
 * usable result, so historical look-back degrades gracefully when an earlier
 * source has no data (or no volume) for a given token/date.
 *
 * `historyOn` prefers a snapshot that includes volume: it keeps the first
 * price-only hit but keeps trying later sources for one that also has volume
 * (volume feeds the liquidity sub-score). `resolve` returns the first non-null id.
 */
export class FallbackPriceHistory implements PriceHistoryProvider {
  constructor(private readonly sources: PriceHistoryProvider[]) {}

  async resolve(query: string): Promise<string | null> {
    for (const s of this.sources) {
      const id = await s.resolve(query).catch(() => null);
      if (id) return id;
    }
    return null;
  }

  async historyOn(id: string, date: Date): Promise<PriceSnapshot | null> {
    let priceOnly: PriceSnapshot | null = null;
    for (const s of this.sources) {
      const snap = await s.historyOn(id, date).catch(() => null);
      if (!snap) continue;
      if (snap.volume24hUsd != null) return snap; // complete (price + volume)
      priceOnly ??= snap; // remember the first price-only hit, keep looking for volume
    }
    return priceOnly;
  }
}
