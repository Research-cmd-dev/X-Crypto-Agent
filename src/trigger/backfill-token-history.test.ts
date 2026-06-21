import { describe, it, expect, vi } from "vitest";
import {
  runTokenHistoryBackfill,
  type TokenHistoryDeps,
  type TokenPriceRow,
} from "@/trigger/backfill-token-history";
import type { HistorySeriesSource, PricePoint } from "@/lib/providers/token-history";

const point = (iso: string, price: number): PricePoint => ({
  at: new Date(iso),
  priceUsd: price,
  volumeUsd: 1000,
  source: "birdeye",
});

function deps(over: Partial<TokenHistoryDeps> = {}): { deps: TokenHistoryDeps; written: TokenPriceRow[] } {
  const written: TokenPriceRow[] = [];
  return {
    written,
    deps: {
      sources: [{ historyRange: vi.fn(async () => [point("2025-03-01T00:00:00Z", 0.01), point("2025-03-01T01:00:00Z", 0.012)]) }],
      recentlyBackfilled: vi.fn(async () => false),
      upsert: vi.fn(async (rows: TokenPriceRow[]) => {
        written.push(...rows);
        return rows.length;
      }),
      now: () => Date.parse("2025-03-02T00:00:00Z"),
      ...over,
    },
  };
}

describe("runTokenHistoryBackfill", () => {
  it("fetches the series and upserts token-keyed rows", async () => {
    const { deps: d, written } = deps();
    const res = await runTokenHistoryBackfill({ chain: "sol", tokenAddress: "mint1" }, d);
    expect(res).toEqual({ inserted: 2, skipped: false });
    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({
      chain: "sol",
      token_address: "mint1",
      observed_at: "2025-03-01T00:00:00.000Z",
      price_usd: 0.01,
      volume_usd: 1000,
      source: "birdeye",
    });
  });

  it("skips when recently backfilled (no fetch, no upsert)", async () => {
    const series = { historyRange: vi.fn(async () => [] as PricePoint[]) } as HistorySeriesSource;
    const { deps: d } = deps({ recentlyBackfilled: vi.fn(async () => true), sources: [series] });
    const res = await runTokenHistoryBackfill({ chain: "sol", tokenAddress: "mint1" }, d);
    expect(res).toEqual({ inserted: 0, skipped: true });
    expect(series.historyRange).not.toHaveBeenCalled();
  });

  it("inserts nothing when the series is empty", async () => {
    const { deps: d, written } = deps({ sources: [{ historyRange: vi.fn(async () => []) }] });
    const res = await runTokenHistoryBackfill({ chain: "sol", tokenAddress: "mint1" }, d);
    expect(res).toEqual({ inserted: 0, skipped: false });
    expect(written).toHaveLength(0);
  });
});
