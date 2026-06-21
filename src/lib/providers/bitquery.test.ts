import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BitqueryPriceHistory } from "@/lib/providers/bitquery";
import { setCacheStore, memoryCacheStore } from "@/lib/cache/store";

function mockResponse(data: unknown) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => data };
}

beforeEach(() => setCacheStore(memoryCacheStore()));
afterEach(() => {
  setCacheStore(null);
  vi.unstubAllGlobals();
});

describe("BitqueryPriceHistory", () => {
  it("returns null (and makes no request) without an API key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const snap = await new BitqueryPriceHistory(undefined).historyOn("mint", new Date());
    expect(snap).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses close price (USD) + summed USD volume from the day's trades", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        mockResponse({
          data: {
            Solana: {
              DEXTradeByTokens: [{ Trade: { Price: 0.0001, PriceInUSD: 0.013 }, volume: "98765.4" }],
            },
          },
        }),
      ),
    );
    const snap = await new BitqueryPriceHistory("key").historyOn("mint", new Date("2025-03-01T12:00:00Z"));
    expect(snap).toEqual({ priceUsd: 0.013, marketCapUsd: null, volume24hUsd: 98765.4 });
  });

  it("returns null when no trades came back", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse({ data: { Solana: { DEXTradeByTokens: [] } } })));
    const snap = await new BitqueryPriceHistory("key").historyOn("mint", new Date());
    expect(snap).toBeNull();
  });
});
