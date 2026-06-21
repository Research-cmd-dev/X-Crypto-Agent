import { supabaseServer } from "@/lib/supabase/server";
import { getXProvider } from "@/lib/providers/x";
import { GithubProvider } from "@/lib/providers/github";
import { PriceProvider } from "@/lib/providers/price";
import type { AgentContext, Providers } from "@/lib/agents/types";
import type { CandidateRow } from "@/lib/supabase/types";
import type { GraphResult } from "@/lib/orchestrator/state";
import { runGraph } from "@/lib/orchestrator/graph";
import { persistResult } from "@/lib/orchestrator/persist";

export { runGraph } from "@/lib/orchestrator/graph";
export type { GraphResult, NodeError } from "@/lib/orchestrator/state";

/** Production provider bundle (real X API v2, GitHub, price). */
export function defaultProviders(): Providers {
  return {
    x: getXProvider(),
    github: new GithubProvider(),
    price: new PriceProvider(),
  };
}

export interface AnalyzeOptions {
  /** Inject providers (e.g. MockXProvider) for tests / offline runs. */
  providers?: Providers;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * End-to-end analysis of one candidate: load it, run the agent graph, persist
 * the result. Marks the candidate `analyzing` -> `analyzed` (or `failed`).
 */
export async function analyzeCandidate(
  candidateId: string,
  opts: AnalyzeOptions = {},
): Promise<GraphResult> {
  const sb = supabaseServer();
  const log = opts.log ?? ((m, meta) => console.log(`[scout] ${m}`, meta ?? ""));

  const { data, error } = await sb
    .from("candidates")
    .select("*")
    .eq("id", candidateId)
    .single();
  if (error || !data) {
    throw new Error(`Candidate ${candidateId} not found: ${error?.message}`);
  }
  const candidate = data as CandidateRow;

  await sb.from("candidates").update({ status: "analyzing" }).eq("id", candidateId);

  const ctx: AgentContext = {
    candidate: {
      id: candidate.id,
      handle: candidate.handle,
      xUserId: candidate.x_user_id,
      displayName: candidate.display_name,
    },
    providers: opts.providers ?? defaultProviders(),
    xUser: null,
    hints: { websiteUrl: null, githubUrl: null, contractAddress: null },
    log,
  };

  try {
    const result = await runGraph(ctx);
    await persistResult(candidateId, result);
    log("analyzed", {
      candidateId,
      overall: result.scores.overall,
      verdict: result.scores.verdict,
      errors: result.errors.length,
    });
    return result;
  } catch (e) {
    await sb.from("candidates").update({ status: "failed" }).eq("id", candidateId);
    throw e;
  }
}
