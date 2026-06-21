import type { Agent, AgentContext, AgentSlice } from "@/lib/agents/types";
import { githubAnalyzerOutputSchema } from "@/lib/schema/analysis";
import { parseStructured } from "@/lib/anthropic/structured";
import { researchText } from "@/lib/anthropic/research";
import { GITHUB_ANALYZER_SYSTEM } from "@/lib/prompts/github.system";
import { parseGithubUrl, type RepoMetrics } from "@/lib/providers/github";

function metricsEvidence(m: RepoMetrics | null): string {
  if (!m) return "No repository metrics could be fetched.";
  return `REAL GITHUB METRICS (${m.url}):
description: ${m.description ?? "(none)"}
stars: ${m.stars}
forks: ${m.forks}
open issues: ${m.openIssues}
last pushed: ${m.pushedAt ?? "unknown"}
commits (last ~90d): ${m.recentCommits}
contributors: ${m.contributors}
languages: ${m.topLanguages.join(", ") || "(unknown)"}`;
}

export const githubAnalyzerAgent: Agent = {
  name: "github-analyzer",

  async run(ctx: AgentContext): Promise<AgentSlice> {
    const url = ctx.hints.githubUrl;

    if (!url) {
      return {
        github: {
          url: null,
          detected: false,
          score: 0,
          activity: "n/a",
          stars: null,
          relevance: "n/a",
          recentCommits: null,
          contributors: null,
          notes: "No GitHub presence detected from the X profile or website.",
        },
        developers: [],
      };
    }

    // Fetch real metrics where possible.
    let metrics: RepoMetrics | null = null;
    const parsed = parseGithubUrl(url);
    if (parsed) {
      try {
        metrics = parsed.repo
          ? await ctx.providers.github.getRepoMetrics(parsed.owner, parsed.repo)
          : await ctx.providers.github.getTopRepoForOwner(parsed.owner);
      } catch (e) {
        ctx.log("github metrics fetch failed", { url, error: String(e) });
      }
    }

    const research = await researchText({
      system: GITHUB_ANALYZER_SYSTEM,
      prompt: `Assess the GitHub presence at ${url} for this crypto project.
Judge how relevant, active, and genuine the engineering work is, and identify
the core contributors.`,
      maxUses: 3,
    }).catch(() => "");

    const out = await parseStructured({
      agent: "github-analyzer",
      schema: githubAnalyzerOutputSchema,
      system: GITHUB_ANALYZER_SYSTEM,
      prompt: `GitHub under review: ${url}

${metricsEvidence(metrics)}

RESEARCH EVIDENCE:
${research || "(no additional research)"}

Produce the structured GitHub assessment now.`,
    });

    return {
      github: {
        ...out.github,
        url: metrics?.url ?? url,
        detected: true,
        // Prefer real numbers over model output.
        stars: metrics?.stars ?? out.github.stars,
        recentCommits: metrics?.recentCommits ?? out.github.recentCommits,
        contributors: metrics?.contributors ?? out.github.contributors,
      },
      developers: out.developers,
    };
  },
};
