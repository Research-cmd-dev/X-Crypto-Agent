import type { Agent, AgentContext, AgentSlice } from "@/lib/agents/types";
import type { Onchain } from "@/lib/schema/analysis";

/**
 * Deterministic on-chain agent. Using the contract address pulled from the
 * bio/posts (ctx.hints), it gathers early-traction signals from Solana Tracker
 * (holders) + Bitquery (traders/trades/launch when available) and best-effort
 * smart-money / risk from GMGN (Agent API). No LLM call — hard data.
 * Pre-token projects yield a neutral empty result rather than a penalty.
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

    const st = ctx.providers.solanatracker ?? null;
    const [bq, stHolders, gm] = await Promise.all([
      ctx.providers.bitquery.tokenOnchain(ca).catch(() => null),
      st ? st.tokenHolders(ca).catch(() => null) : Promise.resolve(null),
      ctx.providers.gmgn.tokenInfo(ca).catch(() => null),
    ]);

    const short = `${ca.slice(0, 6)}…${ca.slice(-4)}`;
    const holdersData: any = stHolders || bq;
    const holderCount = holdersData?.total ?? holdersData?.holderCount ?? gm?.holderCount;
    const traders = bq?.traders24h;
    const trades = bq?.trades24h;

    const gmSmart = gm?.smartMoney || (gm && (gm.smartMoneyCount || gm.riskScore));
    if (holderCount == null && !traders && !trades && !gmSmart) {
      return { onchain: empty(`Contract ${short} found but no on-chain trading data yet.`) };
    }

    const parts: string[] = [];
    if (holderCount != null) parts.push(`${holderCount.toLocaleString()} holders`);
    if (traders != null) parts.push(`${traders.toLocaleString()} traders/24h`);
    if (trades != null) parts.push(`${trades.toLocaleString()} trades/24h`);
    if (gm?.smartMoney) parts.push(`smart money: ${gm.smartMoney}`);
    if (gm?.riskScore != null) parts.push(`GMGN risk: ${gm.riskScore}`);
    if (gm?.smartMoneyCount != null) parts.push(`GMGN sm: ${gm.smartMoneyCount}`);
    if (gm?.holderCount != null && !holdersData?.holderCount) parts.push(`GMGN holders: ${gm.holderCount}`);

    const hasGm = gm?.smartMoney || gm?.riskScore != null || gm?.smartMoneyCount != null || gm?.holderCount != null;
    const source = hasGm
      ? "gmgn" + (stHolders || bq ? "+tracker" : "")
      : (stHolders ? "solanatracker" : "bitquery");

    ctx.log("onchain", {
      contract: short,
      holders: holderCount,
      traders24h: traders,
      trades24h: trades,
      gmgn: gm ? { smart: gm.smartMoney, risk: gm.riskScore, smCount: gm.smartMoneyCount, holders: gm.holderCount } : null,
    });

    return {
      onchain: {
        holderCount: holderCount ?? null,
        traders24h: traders ?? null,
        trades24h: trades ?? null,
        firstTradeAt: bq?.firstTradeAt ?? null,
        smartMoney: gm?.smartMoney ?? null,
        source,
        notes: parts.join(" · ") || "On-chain data resolved.",
        riskScore: gm?.riskScore ?? null,
        smartMoneyCount: gm?.smartMoneyCount ?? null,
      },
    };
  },
};
