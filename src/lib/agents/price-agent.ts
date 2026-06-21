import type { Agent, AgentContext, AgentSlice } from "@/lib/agents/types";

/**
 * Deterministic price/market-context agent. Resolves token market data via the
 * PriceProvider (CoinGecko -> DexScreener). No LLM call needed — this is hard
 * data. Many early projects have no token; that yields a neutral empty result.
 */
export const priceAgent: Agent = {
  name: "price-agent",

  async run(ctx: AgentContext): Promise<AgentSlice> {
    const queries = [
      ctx.candidate.displayName,
      ctx.candidate.handle,
    ].filter((q): q is string => Boolean(q));

    for (const q of queries) {
      const data = await ctx.providers.price.lookup(q).catch(() => null);
      if (data && data.token) {
        return { price: data };
      }
    }

    return {
      price: {
        token: null,
        marketCapUsd: null,
        volume24hUsd: null,
        priceUsd: null,
        source: "none",
        notes: "No token / market data found for this project.",
      },
    };
  },
};
