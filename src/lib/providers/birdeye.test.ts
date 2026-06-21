import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BirdeyePriceHistory, toUnixSeconds } from "@/lib/providers/birdeye";
import { setCacheStore, memoryCacheStore } from "@/lib/cache/store";

function mockResponse(data: unknown) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => data };
}

beforeEach(() => setCacheStore(memoryCacheStore()));
afterEach(() => {
  setCacheStore(null);
  vi.unstubAllGlobals();
});

describe("toUnixSeconds", () => {
  it("converts a date to whole UNIX seconds", () => {
    expect(toUnixSeconds(new Date("2025-01-01T00:00:00Z"))).toBe(1_735_689_600);
  });
});

describe("BirdeyePriceHistory", () => {
  it("returns price + volume from the OHLCV candle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(String(url)).toContain("/defi/ohlcv");
        return mockResponse({ data: { items: [{ c: 0.012, v: 54321 }] } });
      }),
    );
    const snap = await new BirdeyePriceHistory("key").historyOn("mint1", new Date("2025-03-01T00:00:00Z"));
    expect(snap).toEqual({ priceUsd: 0.012, marketCapUsd: null, volume24hUsd: 54321 });
  });

  it("falls back to spot price (no volume) when OHLCV is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/defi/ohlcv")) return mockResponse({ data: { items: [] } });
        if (String(url).includes("history_price_by_timestamp")) return mockResponse({ data: { value: 0.02 } });
        throw new Error("unexpected url " + url);
      }),
    );
    const snap = await new BirdeyePriceHistory("key").historyOn("mint2", new Date("2025-03-01T00:00:00Z"));
    expect(snap).toEqual({ priceUsd: 0.02, marketCapUsd: null, volume24hUsd: null });
  });
});
