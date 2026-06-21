import type { Agent, AgentContext, AgentSlice } from "@/lib/agents/types";
import type { AnalysisReport, Developer } from "@/lib/schema/analysis";
import type { GraphResult, NodeError } from "@/lib/orchestrator/state";
import { xAnalyzerAgent } from "@/lib/agents/x-analyzer";
import { websiteAnalyzerAgent } from "@/lib/agents/website-analyzer";
import { githubAnalyzerAgent } from "@/lib/agents/github-analyzer";
import { priceAgent } from "@/lib/agents/price-agent";
import { runScorer, mergeRedFlags } from "@/lib/agents/scorer";

/** Neutral baseline report so a degraded run still yields a valid object. */
function emptyReport(handle: string): AnalysisReport {
  return {
    account: {
      handle,
      userId: null,
      displayName: null,
      bio: null,
      verified: null,
      createdAt: null,
      location: null,
    },
    profile: {
      followerCount: null,
      followingCount: null,
      followerRatio: null,
      followerSpikes: [],
      followerQuality: { score: 0, notes: "Not analyzed." },
      notableFollowers: [],
    },
    website: {
      url: null,
      detected: false,
      score: 0,
      design: "n/a",
      documentation: "n/a",
      roadmap: "n/a",
      teamInfo: "n/a",
      githubLinksOnSite: [],
      notes: "Not analyzed.",
    },
    github: {
      url: null,
      detected: false,
      score: 0,
      activity: "n/a",
      stars: null,
      relevance: "n/a",
      recentCommits: null,
      contributors: null,
      notes: "Not analyzed.",
    },
    developers: [],
    engagement: {
      momentumScore: 0,
      engagementRate: null,
      avgLikes: null,
      avgReposts: null,
      cadence: "n/a",
      notes: "Not analyzed.",
    },
    smartMoney: { score: 0, notes: "Not analyzed." },
    technicalDepth: { score: 0, notes: "Not analyzed." },
    price: {
      token: null,
      marketCapUsd: null,
      volume24hUsd: null,
      priceUsd: null,
      source: "none",
      notes: "Not analyzed.",
    },
    redFlags: [],
    summary: "",
  };
}

function devKey(d: Developer): string {
  return (d.githubUrl ?? d.handle ?? d.name ?? JSON.stringify(d)).toLowerCase();
}

function dedupeDevelopers(devs: Developer[]): Developer[] {
  const seen = new Set<string>();
  const out: Developer[] = [];
  for (const d of devs) {
    const k = devKey(d);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(d);
    }
  }
  return out;
}

function assemble(handle: string, slices: AgentSlice[]): AnalysisReport {
  const report = emptyReport(handle);
  let developers: Developer[] = [];

  for (const s of slices) {
    if (s.account) report.account = s.account;
    if (s.profile) report.profile = s.profile;
    if (s.website) report.website = s.website;
    if (s.github) report.github = s.github;
    if (s.engagement) report.engagement = s.engagement;
    if (s.smartMoney) report.smartMoney = s.smartMoney;
    if (s.technicalDepth) report.technicalDepth = s.technicalDepth;
    if (s.price) report.price = s.price;
    if (s.summary) report.summary = s.summary;
    if (s.redFlags) report.redFlags = mergeRedFlags(report.redFlags, s.redFlags);
    if (s.developers) developers = developers.concat(s.developers);
  }

  report.developers = dedupeDevelopers(developers);
  return report;
}

async function runNode(
  agent: Agent,
  ctx: AgentContext,
  errors: NodeError[],
): Promise<AgentSlice> {
  try {
    return await agent.run(ctx);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    errors.push({ node: agent.name, message });
    ctx.log(`node failed: ${agent.name}`, { error: message });
    return {};
  }
}

export interface GraphAgents {
  x: Agent;
  website: Agent;
  github: Agent;
  price: Agent;
}

/** Default production agents. Overridable for tests. */
export const DEFAULT_AGENTS: GraphAgents = {
  x: xAnalyzerAgent,
  website: websiteAnalyzerAgent,
  github: githubAnalyzerAgent,
  price: priceAgent,
};

/**
 * The "LangGraph-style" orchestration: a typed state object flows through a
 * fixed node sequence. The X analyzer runs first (it populates hints + xUser);
 * the website / github / price agents then run in parallel; the scorer runs
 * last. Every node is failure-tolerant — a thrown error degrades that slice but
 * never aborts the pipeline.
 */
export async function runGraph(
  ctx: AgentContext,
  agents: GraphAgents = DEFAULT_AGENTS,
): Promise<GraphResult> {
  const errors: NodeError[] = [];

  // Node 1 — X analyzer (sequential: sets ctx.xUser + ctx.hints).
  const xSlice = await runNode(agents.x, ctx, errors);

  // Nodes 2-4 — enrichment, parallel (depend on hints from node 1).
  const [websiteSlice, githubSlice, priceSlice] = await Promise.all([
    runNode(agents.website, ctx, errors),
    runNode(agents.github, ctx, errors),
    runNode(agents.price, ctx, errors),
  ]);

  // Assemble the full report, then score (node 5).
  const report = assemble(ctx.candidate.handle, [
    xSlice,
    websiteSlice,
    githubSlice,
    priceSlice,
  ]);

  const { scores, redFlags } = runScorer(report);
  report.redFlags = redFlags;

  if (!report.summary) {
    report.summary = `Scored ${scores.overall}/100 (${scores.verdict}). ${
      report.github.detected ? "Has GitHub." : "No GitHub."
    } ${report.website.detected ? "Has website." : "No website."}`.trim();
  }

  return { report, scores, errors };
}
