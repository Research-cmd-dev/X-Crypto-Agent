import { supabaseServer } from "@/lib/supabase/server";
import { claudeModel } from "@/lib/anthropic/client";
import type { GraphResult } from "@/lib/orchestrator/state";

/**
 * Persist a graph result: analysis_reports -> scores -> flags, then mark the
 * candidate analyzed. Returns the new report id.
 */
export async function persistResult(
  candidateId: string,
  result: GraphResult,
): Promise<{ reportId: string }> {
  const sb = supabaseServer();

  const { data: report, error: reportErr } = await sb
    .from("analysis_reports")
    .insert({
      candidate_id: candidateId,
      model: claudeModel(),
      payload: result.report,
    })
    .select("id")
    .single();

  if (reportErr || !report) {
    throw new Error(`Failed to insert analysis_report: ${reportErr?.message}`);
  }
  const reportId = report.id as string;

  const s = result.scores;
  const { error: scoreErr } = await sb.from("scores").insert({
    candidate_id: candidateId,
    report_id: reportId,
    profile: s.profile,
    website: s.website,
    github: s.github,
    engagement: s.engagement,
    technical_depth: s.technicalDepth,
    price: s.price,
    overall: s.overall,
    verdict: s.verdict,
  });
  if (scoreErr) throw new Error(`Failed to insert scores: ${scoreErr.message}`);

  if (result.report.redFlags.length > 0) {
    const { error: flagErr } = await sb.from("flags").insert(
      result.report.redFlags.map((f) => ({
        candidate_id: candidateId,
        report_id: reportId,
        severity: f.severity,
        code: f.code,
        message: f.message,
      })),
    );
    if (flagErr) throw new Error(`Failed to insert flags: ${flagErr.message}`);
  }

  const { error: candErr } = await sb
    .from("candidates")
    .update({ status: "analyzed", analyzed_at: new Date().toISOString() })
    .eq("id", candidateId);
  if (candErr) throw new Error(`Failed to update candidate: ${candErr.message}`);

  return { reportId };
}
