import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BirdeyePriceHistory } from "@/lib/providers/birdeye";
import { BitqueryPriceHistory } from "@/lib/providers/bitquery";
import { fetchTokenSeries, type HistorySeriesSource, type PricePoint } from "@/lib/providers/token-history";
import { setCacheStore, memoryCacheStore } from "@/lib/cache/store";

function mockResponse(data: unknown) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => data };
}

beforeEach(() => setCacheStore(memoryCacheStore()));
afterEach(() => {
  setCacheStore(null);
  vi.unstubAllGlobals();
});

const FROM = new Date("2025-03-01T00:00:00Z");
const TO = new Date("2025-03-01T03:00:00Z");

describe("BirdeyePriceHistory.historyRange", () => {
  it("maps hourly OHLCV candles to price points with volume", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(String(url)).toContain("/defi/ohlcv");
        expect(String(url)).toContain("type=1H");
        return mockResponse({
          data: {
            items: [
              { unixTime: 1740787200, c: 0.01, vUsd: 5000 },
              { unixTime: 1740790800, c: 0.012, v: 100000 }, // no vUsd → v*close
            ],
          },
        });
      }),
    );
    const pts = await new BirdeyePriceHistory("key").historyRange("mint", FROM, TO);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toMatchObject({ priceUsd: 0.01, volumeUsd: 5000, source: "birdeye" });
    expect(pts[1].volumeUsd).toBeCloseTo(1200, 6); // 100000 * 0.012
  });
});

describe("BitqueryPriceHistory.historyRange", () => {
  it("maps hourly buckets to price points; empty without a key", async () => {
    expect(await new BitqueryPriceHistory(undefined).historyRange("mint", FROM, TO)).toEqual([]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        mockResponse({
          data: {
            Solana: {
              DEXTradeByTokens: [
                { Block: { Time: "2025-03-01T00:00:00Z" }, Trade: { close: 0.013 }, volume: "2500.5" },
              ],
            },
          },
        }),
      ),
    );
    const pts = await new BitqueryPriceHistory("key").historyRange("mint", FROM, TO);
    expect(pts).toEqual([
      { at: new Date("2025-03-01T00:00:00Z"), priceUsd: 0.013, volumeUsd: 2500.5, source: "bitquery" },
    ]);
  });
});

describe("fetchTokenSeries", () => {
  const src = (pts: PricePoint[]): HistorySeriesSource => ({ historyRange: vi.fn(async () => pts) });
  const point: PricePoint = { at: FROM, priceUsd: 1, volumeUsd: 10, source: "x" };

  it("returns the first non-empty source and skips the rest", async () => {
    const a = src([point]);
    const b = src([{ ...point, priceUsd: 2 }]);
    const out = await fetchTokenSeries("mint", FROM, TO, [a, b]);
    expect(out).toEqual([point]);
    expect(b.historyRange).not.toHaveBeenCalled();
  });

  it("falls through to the next source when the first is empty", async () => {
    const a = src([]);
    const b = src([point]);
    expect(await fetchTokenSeries("mint", FROM, TO, [a, b])).toEqual([point]);
  });
});
