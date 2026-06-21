import type { Agent, AgentContext, AgentSlice } from "@/lib/agents/types";
import type { Onchain } from "@/lib/schema/analysis";

/**
 * Deterministic on-chain agent. Using the contract address pulled from the
 * bio/posts (ctx.hints), it gathers early-traction signals from Bitquery
 * (holders, 24h traders, 24h trades, launch time) and best-effort smart-money /
 * security from GMGN. No LLM call — hard data. Pre-token projects yield a
 * neutral empty result rather than a penalty.
 */
function empty(notes: string, source = "none"): Onchain {
  return {
    holderCount: null,
    traders24h: null,
    trades24h: null,
    firstTradeAt: null,
    smartMoney: null,
    source,
    notes,
  };
}

export const onchainAgent: Agent = {
  name: "onchain-agent",

  async run(ctx: AgentContext): Promise<AgentSlice> {
    const ca = ctx.hints.contractAddress;
    if (!ca) {
      return { onchain: empty("No contract address in bio/posts; treating as pre-token.") };
    }

    const [bq, gm] = await Promise.all([
      ctx.providers.bitquery.tokenOnchain(ca).catch(() => null),
      ctx.providers.gmgn.tokenInfo(ca).catch(() => null),
    ]);

    const short = `${ca.slice(0, 6)}…${ca.slice(-4)}`;
    if (!bq || (bq.holderCount == null && bq.trades24h == null)) {
      return { onchain: empty(`Contract ${short} found but no on-chain trading data yet.`) };
    }

    const parts: string[] = [];
    if (bq.holderCount != null) parts.push(`${bq.holderCount.toLocaleString()} holders`);
    if (bq.traders24h != null) parts.push(`${bq.traders24h.toLocaleString()} traders/24h`);
    if (bq.trades24h != null) parts.push(`${bq.trades24h.toLocaleString()} trades/24h`);
    if (gm?.smartMoney) parts.push(`smart money: ${gm.smartMoney}`);
    const source = gm?.smartMoney || gm?.top10HolderPct != null ? "bitquery+gmgn" : "bitquery";

    ctx.log("onchain", {
      contract: short,
      holders: bq.holderCount,
      traders24h: bq.traders24h,
      trades24h: bq.trades24h,
    });

    return {
      onchain: {
        holderCount: bq.holderCount,
        traders24h: bq.traders24h,
        trades24h: bq.trades24h,
        firstTradeAt: bq.firstTradeAt,
        smartMoney: gm?.smartMoney ?? null,
        source,
        notes: parts.join(" · ") || "On-chain data resolved.",
      },
    };
  },
};
