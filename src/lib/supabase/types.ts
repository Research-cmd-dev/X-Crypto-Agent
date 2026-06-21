// Hand-maintained DB types mirroring supabase/schema.sql.
// (Equivalent to `supabase gen types`, but checked in so the app type-checks
// without a live project.)

export type SignalSourceKind = "account" | "query";
export type CandidateStatus =
  | "discovered"
  | "queued"
  | "analyzing"
  | "analyzed"
  | "failed";
export type Verdict = "High" | "Monitor" | "Avoid";
export type FlagSeverity = "low" | "med" | "high";

export interface SignalSourceRow {
  id: string;
  kind: SignalSourceKind;
  value: string;
  label: string | null;
  weight: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CandidateRow {
  id: string;
  x_user_id: string;
  handle: string;
  display_name: string | null;
  source_id: string | null;
  discovery_note: string | null;
  status: CandidateStatus;
  discovered_at: string;
  analyzed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AnalysisReportRow {
  id: string;
  candidate_id: string;
  model: string;
  payload: unknown; // validated AnalysisReport (see lib/schema/analysis.ts)
  created_at: string;
}

export interface ScoreRow {
  id: string;
  candidate_id: string;
  report_id: string;
  smart_money: number;
  earliness: number;
  profile: number;
  website: number;
  github: number;
  engagement: number;
  technical_depth: number;
  price: number;
  overall: number;
  verdict: Verdict;
  created_at: string;
}

export interface FlagRow {
  id: string;
  candidate_id: string;
  report_id: string;
  severity: FlagSeverity;
  code: string;
  message: string;
  created_at: string;
}

export interface LatestCandidateScoreRow {
  candidate_id: string;
  score_id: string;
  report_id: string;
  smart_money: number;
  earliness: number;
  profile: number;
  website: number;
  github: number;
  engagement: number;
  technical_depth: number;
  price: number;
  overall: number;
  verdict: Verdict;
  created_at: string;
}

/** Row that the dashboard list consumes: candidate + its latest score. */
export interface CandidateWithScore extends CandidateRow {
  score: LatestCandidateScoreRow | null;
}
