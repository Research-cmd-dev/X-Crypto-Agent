/**
 * Offline trace of the scenario: the X scanner finds an account that already has
 * a token (CA in bio) + a github. Shows that the token is now resolved, the
 * on-chain layer runs, the score blends on-chain + social, and an outcome would
 * be tracked — vs. the old social-only behavior.
 *
 *   npm run scanner-demo
 *
 * Runs fully offline: the X/website/github agents are stubbed (no LLM/network);
 * the on-chain agent is the REAL one against MockGmgnProvider.
 */
import { MockXProvider } from "@/lib/providers/x";
import { MockGmgnProvider, MOCK_TOKENS } from "@/lib/providers/gmgn";
import { GithubProvider } from "@/lib/providers/github";
import { PriceProvider } from "@/lib/providers/price";
import { runGraph, type GraphAgents } from "@/lib/orchestrator/graph";
import { onchainAnalyzerAgent } from "@/lib/agents/onchain-analyzer";
import { extractSolanaToken } from "@/lib/discovery/token-link";
import type { AgentContext } from "@/lib/agents/types";

async function main() {
  const bio = `building the next thing. CA: ${MOCK_TOKENS.GEM.address} 🚀`;
  const urls = ["https://github.com/gem/gem", "https://gemcoin.xyz"];
  const tokenAddress = extractSolanaToken(bio, urls);
  console.log(`X scanner found @gemcoin → resolved token from bio/links: ${tokenAddress ?? "NONE"}\n`);

  // Stub the LLM agents; use the REAL on-chain agent against the mock GMGN.
  const agents: GraphAgents = {
    x: {
      name: "x-analyzer",
      run: async () => ({
        account: { handle: "gemcoin", userId: "x1", displayName: "Gem", bio, verified: false, createdAt: "2024-06-01", location: null },
        profile: { followerCount: 8000, followingCount: 200, followerRatio: 40, followerSpikes: [], followerQuality: { score: 75, notes: "" }, notableFollowers: [] },
        engagement: { momentumScore: 68, engagementRate: 4, avgLikes: 100, avgReposts: 20, cadence: "daily", notes: "" },
        smartMoney: { score: 72, notes: "Two known funds following early." },
        technicalDepth: { score: 55, notes: "" },
        developers: [],
        redFlags: [],
        summary: "Credible account with a linked token.",
      }),
    },
    website: { name: "website-analyzer", run: async () => ({ website: { url: "https://gemcoin.xyz", detected: true, score: 65, design: "", documentation: "", roadmap: "", teamInfo: "", githubLinksOnSite: [], notes: "" } }) },
    github: { name: "github-analyzer", run: async () => ({ github: { url: "https://github.com/gem/gem", detected: true, score: 70, activity: "", stars: 300, relevance: "", recentCommits: 40, contributors: 3, notes: "" } }) },
    price: { name: "price-agent", run: async () => ({}) }, // CoinGecko miss; on-chain provides price
    onchain: onchainAnalyzerAgent,
  };

  const ctx: AgentContext = {
    candidate: { id: "demo", handle: "gemcoin", xUserId: "x1", displayName: "Gem", tokenAddress, chain: tokenAddress ? "sol" : null },
    providers: { x: new MockXProvider(), github: new GithubProvider(), price: new PriceProvider(), gmgn: new MockGmgnProvider() },
    xUser: null,
    hints: { websiteUrl: null, githubUrl: null },
    log: () => {},
  };

  const { report, scores } = await runGraph(ctx, agents);
  const o = report.onchain;
  console.log(`verdict:        ${scores.verdict} (${scores.overall}/100)`);
  console.log(`on-chain layer: ${o ? "PRESENT" : "MISSING"}` + (o ? ` (smartMoney=${o.smartMoneyCount} wallets, top10=${o.topHolderConcentration}, rug=${o.rugRatio})` : ""));
  console.log(`sub-scores:     smartMoney=${scores.smartMoney} (on-chain×X blend)  engagement=${scores.engagement}  profile=${scores.profile}  github=${scores.github}  earliness=${scores.earliness}  price=${scores.price}`);
  console.log(`red flags:      ${report.redFlags.map((f) => f.code).join(", ") || "none"}`);
  console.log(`outcome:        ${report.price.token || report.onchain ? "SEEDED (forward-return tracked, matures via GMGN)" : "not tracked"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
