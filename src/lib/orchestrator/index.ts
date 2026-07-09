import { supabaseServer } from "@/lib/supabase/server";
import { getXProvider } from "@/lib/providers/x";
import { GithubProvider } from "@/lib/providers/github";
import { PriceProvider } from "@/lib/providers/price";
import { BitqueryProvider } from "@/lib/providers/bitquery";
import { GmgnProvider } from "@/lib/providers/gmgn";
import { SolanaTrackerProvider } from "@/lib/providers/solanatracker";
import type { AgentContext, Providers } from "@/lib/agents/types";
import type { CandidateRow } from "@/lib/supabase/types";
import type { GraphResult } from "@/lib/orchestrator/state";
import { runGraph } from "@/lib/orchestrator/graph";
import { persistResult } from "@/lib/orchestrator/persist";

export { runGraph } from "@/lib/orchestrator/graph";
export type { GraphResult, NodeError } from "@/lib/orchestrator/state";

/** Production provider bundle (real X API v2, GitHub, price, on-chain via SolanaTracker + GMGN). */
export function defaultProviders(): Providers {
  return {
    x: getXProvider(),
    github: new GithubProvider(),
    price: new PriceProvider(),
    bitquery: new BitqueryProvider(),
    gmgn: new GmgnProvider(),
    solanatracker: process.env.SOLANATRACKER_API_KEY ? new SolanaTrackerProvider() : undefined,
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

  // Very cheap in-memory cache for recent full results (per process, survives short restarts in dev).
  // Keyed by candidateId + coarse time bucket to avoid re-running identical recent data.
  const ANALYSIS_CACHE = (globalThis as any).__analysisCache ||= new Map<string, { result: GraphResult; ts: number }>();
  const ANALYSIS_CACHE_TTL = 1000 * 60 * 60; // 1h
  const cacheKey = `${candidateId}`;
  const cached = ANALYSIS_CACHE.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < ANALYSIS_CACHE_TTL) {
    log("analysis cache hit", { candidateId });
    return cached.result;
  }

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
    hints: {
      websiteUrl: null,
      githubUrl: null,
      contractAddress: candidate.token_address ?? null,
    },
    log,
  };

  try {
    const result = await runGraph(ctx);
    await persistResult(candidateId, result);
    // Rough cost signal (helps tune discovery volume). Real costs tracked via provider logs / xAI dashboard.
    const llmCalls = 1 + (result.report.website?.detected ? 1 : 0) + (result.report.github?.detected ? 1 : 0);
    log("analyzed", {
      candidateId,
      overall: result.scores.overall,
      verdict: result.scores.verdict,
      errors: result.errors.length,
      approx_llm_calls: llmCalls,
      has_onchain: !!result.report.onchain?.holderCount || !!result.report.onchain?.traders24h,
    });

    // Cache the result
    ANALYSIS_CACHE.set(cacheKey, { result, ts: Date.now() });
    return result;
  } catch (e) {
    await sb.from("candidates").update({ status: "failed" }).eq("id", candidateId);
    throw e;
  }
}
