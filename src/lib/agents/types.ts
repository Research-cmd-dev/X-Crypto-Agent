import type { XProvider, XUser } from "@/lib/providers/x";
import type { GithubProvider } from "@/lib/providers/github";
import type { PriceProvider } from "@/lib/providers/price";
import type { GmgnProvider } from "@/lib/providers/gmgn";
import type { AnalysisReport } from "@/lib/schema/analysis";

export interface Providers {
  x: XProvider;
  github: GithubProvider;
  price: PriceProvider;
  gmgn: GmgnProvider;
}

export interface CandidateRef {
  id: string;
  handle: string;
  xUserId: string | null;
  displayName: string | null;
  /** Token contract / mint address for on-chain (token) candidates; null for account candidates. */
  tokenAddress: string | null;
  chain: string | null;
}

/**
 * Shared, evolving context passed through the agent graph. Earlier agents
 * (the X analyzer) populate `xUser` and `hints` for later agents to use.
 */
export interface AgentContext {
  candidate: CandidateRef;
  providers: Providers;
  xUser: XUser | null;
  hints: { websiteUrl: string | null; githubUrl: string | null };
  log: (msg: string, meta?: Record<string, unknown>) => void;
}

/** Each agent returns a partial of the full report; the orchestrator merges. */
export type AgentSlice = Partial<AnalysisReport>;

export interface Agent {
  name: string;
  run(ctx: AgentContext): Promise<AgentSlice>;
}
