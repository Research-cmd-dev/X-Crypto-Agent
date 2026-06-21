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
  weightVersionId: string | null = null,
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
    smart_money: s.smartMoney,
    earliness: s.earliness,
    profile: s.profile,
    website: s.website,
    github: s.github,
    engagement: s.engagement,
    technical_depth: s.technicalDepth,
    price: s.price,
    overall: s.overall,
    verdict: s.verdict,
    weight_version_id: weightVersionId,
  });
  if (scoreErr) throw new Error(`Failed to insert scores: ${scoreErr.message}`);

  // Seed a forward-return tracking row for projects that already have a token.
  // The frozen price at scoring time is the entry baseline; the scheduled
  // `outcomes` job fills in later prices until the horizon matures. Pre-token
  // candidates get no row (nothing to measure yet).
  const price = result.report.price;
  const onchain = result.report.onchain;
  if (price.token || onchain) {
    const { error: outErr } = await sb.from("outcomes").upsert(
      {
        candidate_id: candidateId,
        report_id: reportId,
        token_ref: price.token,
        // On-chain tokens carry the mint + chain so maturation re-looks-up the
        // current price via GMGN/Birdeye (memecoins aren't on CoinGecko by symbol).
        chain: onchain?.chain ?? null,
        token_address: onchain?.tokenAddress ?? null,
        baseline_price_usd: price.priceUsd,
        baseline_mcap_usd: price.marketCapUsd,
        baseline_at: new Date().toISOString(),
      },
      { onConflict: "report_id" },
    );
    if (outErr) throw new Error(`Failed to insert outcome: ${outErr.message}`);
  }

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
