import { describe, it, expect, vi } from "vitest";
import { FallbackPriceHistory } from "@/lib/providers/fallback-history";
import type { PriceHistoryProvider, PriceSnapshot } from "@/lib/providers/price";

const provider = (snap: PriceSnapshot | null, id: string | null = "x"): PriceHistoryProvider => ({
  resolve: vi.fn(async () => id),
  historyOn: vi.fn(async () => snap),
});

describe("FallbackPriceHistory", () => {
  it("returns the first source with price + volume and short-circuits", async () => {
    const a = provider({ priceUsd: 1, marketCapUsd: null, volume24hUsd: 100 });
    const b = provider({ priceUsd: 2, marketCapUsd: null, volume24hUsd: 200 });
    const snap = await new FallbackPriceHistory([a, b]).historyOn("m", new Date());
    expect(snap?.priceUsd).toBe(1);
    expect(b.historyOn).not.toHaveBeenCalled();
  });

  it("skips a price-only source for a later one that also has volume", async () => {
    const a = provider({ priceUsd: 1, marketCapUsd: null, volume24hUsd: null });
    const b = provider({ priceUsd: 2, marketCapUsd: null, volume24hUsd: 200 });
    const snap = await new FallbackPriceHistory([a, b]).historyOn("m", new Date());
    expect(snap).toEqual({ priceUsd: 2, marketCapUsd: null, volume24hUsd: 200 });
  });

  it("keeps the first price-only hit when no later source has volume", async () => {
    const a = provider({ priceUsd: 1, marketCapUsd: null, volume24hUsd: null });
    const b = provider(null);
    const snap = await new FallbackPriceHistory([a, b]).historyOn("m", new Date());
    expect(snap?.priceUsd).toBe(1);
  });

  it("resolve returns the first non-null id", async () => {
    const a = provider(null, null);
    const b = provider(null, "mint-b");
    expect(await new FallbackPriceHistory([a, b]).resolve("q")).toBe("mint-b");
  });
});
