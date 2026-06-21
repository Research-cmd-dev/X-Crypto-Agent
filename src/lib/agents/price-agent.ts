import type { Agent, AgentContext, AgentSlice } from "@/lib/agents/types";

/**
 * Deterministic price/market-context agent. Resolves token market data by the
 * on-chain **contract address** pulled from the bio/posts (set in ctx.hints by
 * the X analyzer) via the PriceProvider (Birdeye -> DexScreener). No LLM call —
 * this is hard data. Many super-early projects have no token / no market yet;
 * that yields a neutral empty result rather than a penalty.
 */
export const priceAgent: Agent = {
  name: "price-agent",

  async run(ctx: AgentContext): Promise<AgentSlice> {
    const ca = ctx.hints.contractAddress;

    if (!ca) {
      return {
        price: {
          token: null,
          marketCapUsd: null,
          volume24hUsd: null,
          priceUsd: null,
          source: "none",
          notes: "No on-chain contract address found in bio/posts; treating as pre-token.",
        },
      };
    }

    const data = await ctx.providers.price.lookupByMint(ca).catch(() => null);
    if (data && data.token) {
      return { price: data };
    }

    return {
      price: {
        token: null,
        marketCapUsd: null,
        volume24hUsd: null,
        priceUsd: null,
        source: "none",
        notes: `Contract ${ca.slice(0, 6)}…${ca.slice(-4)} found but no market data yet.`,
      },
    };
  },
};
