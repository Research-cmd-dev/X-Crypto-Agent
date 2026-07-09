import { describe, it, expect } from "vitest";
import { runGraph, type GraphAgents } from "@/lib/orchestrator/graph";
import type { Agent, AgentContext } from "@/lib/agents/types";
import { MockXProvider } from "@/lib/providers/x";
import { GithubProvider } from "@/lib/providers/github";
import { PriceProvider } from "@/lib/providers/price";
import { BitqueryProvider } from "@/lib/providers/bitquery";
import { GmgnProvider } from "@/lib/providers/gmgn";
import { SolanaTrackerProvider } from "@/lib/providers/solanatracker";

function ctx(): AgentContext {
  return {
    candidate: { id: "c1", handle: "exampledefi", xUserId: "1001", displayName: "ExampleDeFi" },
    providers: {
      x: new MockXProvider(),
      github: new GithubProvider(),
      price: new PriceProvider(),
      bitquery: new BitqueryProvider(),
      gmgn: new GmgnProvider(),
      solanatracker: process.env.SOLANATRACKER_API_KEY ? new SolanaTrackerProvider() : undefined,
    },
    xUser: null,
    hints: { websiteUrl: null, githubUrl: null, contractAddress: null },
    log: () => {},
  };
}

const fakeAgents = (overrides: Partial<GraphAgents> = {}): GraphAgents => ({
  x: {
    name: "x-analyzer",
    run: async () => ({
      account: { handle: "exampledefi", userId: "1001", displayName: "ExampleDeFi", bio: null, verified: false, createdAt: null, location: null },
      profile: { followerCount: 48000, followingCount: 210, followerRatio: 228.6, followerSpikes: [], followerQuality: { score: 80, notes: "real" }, notableFollowers: [] },
      engagement: { momentumScore: 75, avgLikes: 800, avgReposts: 200, cadence: "daily", notes: "" },
      technicalDepth: { score: 70, notes: "" },
      developers: [{ handle: "devone", name: null, githubUrl: "https://github.com/exampledefi", signals: [], qualityNote: "core" }],
      redFlags: [],
      summary: "Strong project.",
    }),
  },
  website: {
    name: "website-analyzer",
    run: async () => ({ website: { url: "https://exampledefi.xyz", detected: true, score: 85, design: "", documentation: "", roadmap: "", teamInfo: "", githubLinksOnSite: [], notes: "" } }),
  },
  github: {
    name: "github-analyzer",
    run: async () => ({
      github: { url: "https://github.com/exampledefi", detected: true, score: 80, activity: "", stars: 1200, relevance: "", recentCommits: 90, contributors: 8, notes: "" },
      developers: [{ handle: "devone", name: null, githubUrl: "https://github.com/exampledefi", signals: ["active"], qualityNote: "core dev" }],
    }),
  },
  price: { name: "price-agent", run: async () => ({ price: { token: null, marketCapUsd: null, volume24hUsd: null, priceUsd: null, source: "none", notes: "" } }) },
  onchain: {
    name: "onchain-agent",
    run: async () => ({
      onchain: { holderCount: 8000, traders24h: 1500, trades24h: 50000, firstTradeAt: null, smartMoney: null, source: "bitquery", notes: "" },
    }),
  },
  ...overrides,
});

describe("runGraph", () => {
  it("assembles slices and scores a strong project as High", async () => {
    const result = await runGraph(ctx(), fakeAgents());
    expect(result.errors).toHaveLength(0);
    expect(result.report.website.detected).toBe(true);
    expect(result.report.github.detected).toBe(true);
    expect(result.scores.verdict).toBe("High");
    // developers from x + github are merged and de-duplicated by github url
    expect(result.report.developers).toHaveLength(1);
  });

  it("tolerates a failing node and records the error without aborting", async () => {
    const broken: Agent = {
      name: "github-analyzer",
      run: async () => {
        throw new Error("github exploded");
      },
    };
    const result = await runGraph(ctx(), fakeAgents({ github: broken }));
    expect(result.errors.some((e) => e.node === "github-analyzer")).toBe(true);
    // Pipeline still produced a scored report (degraded github slice).
    expect(result.report.github.detected).toBe(false);
    expect(result.scores.overall).toBeGreaterThanOrEqual(0);
    // Structural red flag for the missing github should appear.
    expect(result.report.redFlags.some((f) => f.code === "no_github")).toBe(true);
  });

  it("incorporates price + onchain slices and still succeeds with a degraded node", async () => {
    const brokenPrice: Agent = {
      name: "price-agent",
      run: async () => {
        throw new Error("price provider down");
      },
    };
    const result = await runGraph(ctx(), fakeAgents({ price: brokenPrice }));
    expect(result.errors.some((e) => e.node === "price-agent")).toBe(true);
    expect(result.report.price.source).toBe("none"); // degraded default
    expect(result.scores.onchain).toBeGreaterThan(50); // strong onchain from fake
    expect(result.scores.overall).toBeGreaterThanOrEqual(0);
  });
});
