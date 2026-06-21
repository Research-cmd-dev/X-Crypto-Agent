import { describe, it, expect, vi } from "vitest";
import { currentPriceForOutcome, type MaturationSources } from "@/lib/scoring/maturation";
import { MockGmgnProvider, MOCK_TOKENS } from "@/lib/providers/gmgn";

function sources(coingeckoPrice = { priceUsd: 1.5, marketCapUsd: 3000 }): MaturationSources {
  return {
    coingecko: { lookup: vi.fn(async () => coingeckoPrice) },
    gmgn: new MockGmgnProvider(),
  };
}

describe("currentPriceForOutcome", () => {
  it("routes on-chain tokens (mint) to GMGN, with volume", async () => {
    const s = sources();
    const price = await currentPriceForOutcome(
      { token_ref: "GEM", token_address: MOCK_TOKENS.GEM.address, chain: "sol" },
      s,
    );
    expect(price).toEqual({ priceUsd: 0.0021, marketCapUsd: 2_100_000, volume24hUsd: 420_000 });
    expect(s.coingecko.lookup).not.toHaveBeenCalled(); // didn't fall through to CoinGecko
  });

  it("routes non-token (symbol only) candidates to CoinGecko, volume null", async () => {
    const s = sources({ priceUsd: 2.2, marketCapUsd: 9000 });
    const price = await currentPriceForOutcome(
      { token_ref: "WIF", token_address: null, chain: null },
      s,
    );
    expect(price).toEqual({ priceUsd: 2.2, marketCapUsd: 9000, volume24hUsd: null });
    expect(s.coingecko.lookup).toHaveBeenCalledWith("WIF");
  });

  it("returns nulls when GMGN has no data for the mint", async () => {
    const price = await currentPriceForOutcome(
      { token_ref: null, token_address: "UnknownMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", chain: "sol" },
      sources(),
    );
    expect(price).toEqual({ priceUsd: null, marketCapUsd: null, volume24hUsd: null });
  });
});
