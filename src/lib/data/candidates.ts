import { supabaseServer } from "@/lib/supabase/server";
import type {
  CandidateRow,
  CandidateWithScore,
  LatestCandidateScoreRow,
  FlagRow,
  Verdict,
} from "@/lib/supabase/types";
import type { AnalysisReport } from "@/lib/schema/analysis";

export interface ListOptions {
  verdict?: Verdict;
  limit?: number;
}

/** A dashboard row: candidate + latest score + alpha signals from the report. */
export interface CandidateListItem extends CandidateWithScore {
  marketCapUsd: number | null;
  engagementRate: number | null;
  notableFollowerCount: number;
}

interface ReportSignals {
  marketCapUsd: number | null;
  engagementRate: number | null;
  notableFollowerCount: number;
}

/** List candidates joined with their latest score (for the dashboard table). */
export async function listCandidatesWithScores(
  opts: ListOptions = {},
): Promise<CandidateListItem[]> {
  const sb = supabaseServer();
  const limit = opts.limit ?? 200;

  const { data: candidates, error } = await sb
    .from("candidates")
    .select("*")
    .order("discovered_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  const rows = (candidates ?? []) as CandidateRow[];
  if (rows.length === 0) return [];

  const { data: scores } = await sb
    .from("latest_candidate_scores")
    .select("*")
    .in(
      "candidate_id",
      rows.map((r) => r.id),
    );

  const scoreRows = (scores ?? []) as LatestCandidateScoreRow[];
  const scoreByCandidate = new Map<string, LatestCandidateScoreRow>(
    scoreRows.map((s) => [s.candidate_id, s]),
  );

  // Attach alpha signals from each candidate's latest report (referenced by the score).
  const reportIds = scoreRows.map((s) => s.report_id);
  const signalsByReport = new Map<string, ReportSignals>();
  if (reportIds.length > 0) {
    const { data: reports } = await sb
      .from("analysis_reports")
      .select("id, payload")
      .in("id", reportIds);
    for (const r of reports ?? []) {
      const payload = r.payload as AnalysisReport | null;
      signalsByReport.set(r.id as string, {
        marketCapUsd: payload?.price?.marketCapUsd ?? null,
        engagementRate: payload?.engagement?.engagementRate ?? null,
        notableFollowerCount: payload?.profile?.notableFollowers?.length ?? 0,
      });
    }
  }

  const merged: CandidateListItem[] = rows.map((c) => {
    const score = scoreByCandidate.get(c.id) ?? null;
    const sig = score ? signalsByReport.get(score.report_id) : undefined;
    return {
      ...c,
      score,
      marketCapUsd: sig?.marketCapUsd ?? null,
      engagementRate: sig?.engagementRate ?? null,
      notableFollowerCount: sig?.notableFollowerCount ?? 0,
    };
  });

  // Optional verdict filter (server-side).
  const filtered = opts.verdict
    ? merged.filter((c) => c.score?.verdict === opts.verdict)
    : merged;

  // Surface highest-scoring first; unscored candidates last.
  return filtered.sort(
    (a, b) => (b.score?.overall ?? -1) - (a.score?.overall ?? -1),
  );
}

export interface CandidateDetail {
  candidate: CandidateRow;
  report: AnalysisReport | null;
  score: LatestCandidateScoreRow | null;
  flags: FlagRow[];
  reportCreatedAt: string | null;
}

/** Full detail for one candidate: latest report payload + score + flags. */
export async function getCandidateDetail(
  candidateId: string,
): Promise<CandidateDetail | null> {
  const sb = supabaseServer();

  const { data: candidate } = await sb
    .from("candidates")
    .select("*")
    .eq("id", candidateId)
    .single();
  if (!candidate) return null;

  const { data: reportRow } = await sb
    .from("analysis_reports")
    .select("id, payload, created_at")
    .eq("candidate_id", candidateId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: score } = await sb
    .from("latest_candidate_scores")
    .select("*")
    .eq("candidate_id", candidateId)
    .maybeSingle();

  const reportId = reportRow?.id as string | undefined;
  const { data: flags } = reportId
    ? await sb.from("flags").select("*").eq("report_id", reportId)
    : { data: [] as FlagRow[] };

  return {
    candidate: candidate as CandidateRow,
    report: (reportRow?.payload as AnalysisReport | undefined) ?? null,
    score: (score as LatestCandidateScoreRow | null) ?? null,
    flags: (flags ?? []) as FlagRow[],
    reportCreatedAt: (reportRow?.created_at as string | undefined) ?? null,
  };
}
