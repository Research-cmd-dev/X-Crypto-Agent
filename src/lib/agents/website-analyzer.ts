import type { Agent, AgentContext, AgentSlice } from "@/lib/agents/types";
import { websiteAnalyzerOutputSchema } from "@/lib/schema/analysis";
import { researchText } from "@/lib/llm/research";
import { parseStructured } from "@/lib/llm/structured";
import { WEBSITE_ANALYZER_SYSTEM } from "@/lib/prompts/website.system";

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export const websiteAnalyzerAgent: Agent = {
  name: "website-analyzer",

  async run(ctx: AgentContext): Promise<AgentSlice> {
    const url = ctx.hints.websiteUrl;

    if (!url) {
      return {
        website: {
          url: null,
          detected: false,
          score: 0,
          design: "n/a",
          documentation: "n/a",
          roadmap: "n/a",
          teamInfo: "n/a",
          githubLinksOnSite: [],
          notes: "No website detected from the X profile or research.",
        },
      };
    }

    const domain = domainOf(url);
    const research = await researchText({
      system: WEBSITE_ANALYZER_SYSTEM,
      prompt: `Fetch and assess this crypto project website: ${url}
Evaluate its design, documentation/whitepaper, roadmap, and team info, and list
any GitHub links found on the site.`,
      allowFetch: true,
      allowedDomains: domain ? [domain] : undefined,
      maxUses: 2, // cost control
    }).catch((e) => {
      ctx.log("website research failed", { url, error: String(e) });
      return "";
    });

    const out = await parseStructured({
      agent: "website-analyzer",
      schema: websiteAnalyzerOutputSchema,
      system: WEBSITE_ANALYZER_SYSTEM,
      prompt: `Website under review: ${url}

RESEARCH EVIDENCE:
${research || "(could not fetch site content)"}

Produce the structured website assessment now.`,
    });

    return {
      website: { ...out.website, url, detected: true },
    };
  },
};
