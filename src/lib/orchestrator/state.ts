import type { AnalysisReport } from "@/lib/schema/analysis";
import type { ScoreBreakdown } from "@/lib/schema/scoring";

export interface NodeError {
  node: string;
  message: string;
}

export interface GraphResult {
  report: AnalysisReport;
  scores: ScoreBreakdown;
  /** Per-node failures; non-empty means the report ran in a degraded mode. */
  errors: NodeError[];
}
