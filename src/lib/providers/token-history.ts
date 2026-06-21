/** One point in a token's price/volume series (hourly candle). */
export interface PricePoint {
  at: Date;
  priceUsd: number;
  volumeUsd: number | null;
  source: string;
}

/** A source that can return a token's price/volume series over a time range. */
export interface HistorySeriesSource {
  historyRange(mint: string, from: Date, to: Date): Promise<PricePoint[]>;
}

/**
 * Fetch a token's hourly price+volume series, trying sources in order
 * (Birdeye → Bitquery) and returning the first non-empty result. Per-hour
 * gap-merging across sources is a noted later enhancement.
 */
export async function fetchTokenSeries(
  mint: string,
  from: Date,
  to: Date,
  sources: HistorySeriesSource[],
): Promise<PricePoint[]> {
  for (const s of sources) {
    const pts = await s.historyRange(mint, from, to).catch(() => [] as PricePoint[]);
    if (pts.length > 0) return pts;
  }
  return [];
}
