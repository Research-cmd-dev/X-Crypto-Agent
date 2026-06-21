import type { Agent, AgentContext, AgentSlice } from "@/lib/agents/types";
import { buildOnchain, priceFromSummary } from "@/lib/scoring/onchain";

/**
 * On-chain analyzer: for a token candidate, assemble the `onchain` report section
 * (security + smart money + holders via GMGN) and the live `price` section. A
 * no-op for account-only candidates (no token address). Failure-tolerant — a
 * thrown error just degrades the slice (the graph runner catches it).
 *
 * The token's X handle (`link.twitter`) is resolved upstream by the migration job
 * and stored as the candidate handle, so the X analyzer scores the social layer.
 */
export const onchainAnalyzerAgent: Agent = {
  name: "onchain-analyzer",
  async run(ctx: AgentContext): Promise<AgentSlice> {
    const address = ctx.candidate.tokenAddress;
    if (!address) return {};
    const chain = ctx.candidate.chain ?? "sol";
    const gmgn = ctx.providers.gmgn;

    const summary = await gmgn.tokenInfo(address, chain);
    if (!summary) return {};

    const [security, traders] = await Promise.all([
      gmgn.tokenSecurity(address, chain).catch(() => null),
      gmgn.topTraders(address, chain).catch(() => []),
    ]);

    ctx.log("onchain analyzed", { address, smartMoney: summary.smartMoneyCount, twitter: summary.twitter });

    return {
      onchain: buildOnchain(summary, security, traders),
      price: priceFromSummary(summary),
    };
  },
};
