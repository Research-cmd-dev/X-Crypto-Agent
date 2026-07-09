import { task } from "@trigger.dev/sdk/v3";
import { supabaseServer } from "@/lib/supabase/server";
import { analyzeCandidate } from "@/lib/orchestrator";

export interface AnalyzeCandidatePayload {
  candidateId: string;
  /** Skip if the candidate was analyzed within this many minutes (idempotency). */
  freshnessMinutes?: number;
}

/**
 * Runs the multi-agent orchestrator for a single candidate. Concurrency-limited
 * to be gentle on the X / Grok (xAI) APIs; retries are configured globally in
 * trigger.config.ts.
 */
export const analyzeCandidateTask = task({
  id: "analyze-candidate",
  maxDuration: 600,
  queue: { concurrencyLimit: 4 },
  run: async (payload: AnalyzeCandidatePayload) => {
    const { candidateId, freshnessMinutes = 720 } = payload; // default 12h to minimize repeated Grok costs

    // Idempotency: skip if recently analyzed.
    const sb = supabaseServer();
    const { data: existing } = await sb
      .from("candidates")
      .select("status, analyzed_at")
      .eq("id", candidateId)
      .single();

    if (existing?.status === "analyzed" && existing.analyzed_at) {
      const ageMin = (Date.now() - new Date(existing.analyzed_at).getTime()) / 60000;
      if (ageMin < freshnessMinutes) {
        return { candidateId, skipped: true as const, reason: "recently_analyzed" };
      }
    }

    const result = await analyzeCandidate(candidateId);
    return {
      candidateId,
      skipped: false as const,
      overall: result.scores.overall,
      verdict: result.scores.verdict,
      degraded: result.errors.length > 0,
      errors: result.errors,
    };
  },
});
