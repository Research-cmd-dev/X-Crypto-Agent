import { supabaseServer } from "@/lib/supabase/server";
import {
  computeScores,
  DEFAULT_PROFILE,
  type ScoringProfile,
} from "@/lib/schema/scoring";
import { analysisReportSchema, type AnalysisReport } from "@/lib/schema/analysis";

/** One labeled data point: a frozen report + the token's realized forward return. */
export interface BacktestSample {
  report: AnalysisReport;
  forwardReturn: number;
  /** Signals validly measured for this sample (historical sets); undefined = all. */
  measuredSignals?: string[];
}

const WEIGHT_KEYS = [
  "smartMoney",
  "engagement",
  "earliness",
  "profile",
  "technicalDepth",
  "website",
  "github",
  "price",
] as const;

type WeightKey = (typeof WEIGHT_KEYS)[number];

/**
 * Spearman rank correlation. Ranks each series (ties get the mean rank), then
 * takes the Pearson correlation of the ranks. Returns 0 for degenerate input
 * (n < 2 or a constant series). Range [-1, 1].
 */
export function spearman(pairs: { score: number; ret: number }[]): number {
  const n = pairs.length;
  if (n < 2) return 0;

  const rank = (vals: number[]): number[] => {
    const order = vals.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const ranks = new Array<number>(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && order[j + 1][0] === order[i][0]) j++;
      const avgRank = (i + j) / 2 + 1; // 1-based, averaged across ties
      for (let k = i; k <= j; k++) ranks[order[k][1]] = avgRank;
      i = j + 1;
    }
    return ranks;
  };

  const rs = rank(pairs.map((p) => p.score));
  const rr = rank(pairs.map((p) => p.ret));
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const ms = mean(rs);
  const mr = mean(rr);
  let num = 0;
  let ds = 0;
  let dr = 0;
  for (let i = 0; i < n; i++) {
    const a = rs[i] - ms;
    const b = rr[i] - mr;
    num += a * b;
    ds += a * a;
    dr += b * b;
  }
  if (ds === 0 || dr === 0) return 0;
  return num / Math.sqrt(ds * dr);
}

/**
 * Fitness of a weight profile on a labeled set: rank correlation between each
 * report's overall score (under that profile) and its realized forward return.
 * Higher = the score ordered winners ahead of losers more reliably.
 */
export function fitness(samples: BacktestSample[], profile: ScoringProfile): number {
  if (samples.length < 2) return 0;
  const pairs = samples.map((s) => ({
    score: computeScores(s.report, profile).overall,
    ret: s.forwardReturn,
  }));
  return spearman(pairs);
}

export interface SignalQuality {
  key: WeightKey;
  /** Spearman of this signal's sub-score vs. forward return. */
  correlation: number;
}

/**
 * Per-signal predictive power: for each sub-score, the rank correlation between
 * it and the realized forward return. This is the most honest read on a
 * price-only historical set — it shows which (reconstructable) signals actually
 * predicted returns, without conflating them through the weighted overall.
 */
export function signalQualityReport(
  samples: BacktestSample[],
  profile: ScoringProfile = DEFAULT_PROFILE,
): SignalQuality[] {
  const breakdowns = samples.map((s) => ({
    sub: computeScores(s.report, profile),
    ret: s.forwardReturn,
  }));
  return WEIGHT_KEYS.map((key) => ({
    key,
    correlation: spearman(breakdowns.map((b) => ({ score: b.sub[key], ret: b.ret }))),
  })).sort((a, b) => b.correlation - a.correlation);
}

/**
 * Renormalize weights to sum to 1, but only redistribute budget among `tunable`
 * keys — non-tunable keys stay pinned at their `base` value. With all keys
 * tunable this is a plain clamp-and-normalize to 1.
 */
function normalizeMasked(
  w: Record<WeightKey, number>,
  base: Record<WeightKey, number>,
  tunable: readonly WeightKey[],
): Record<WeightKey, number> {
  const tunableSet = new Set<WeightKey>(tunable);
  let fixedSum = 0;
  for (const k of WEIGHT_KEYS) if (!tunableSet.has(k)) fixedSum += Math.max(0, base[k]);
  const budget = Math.max(0, 1 - fixedSum);

  let tSum = 0;
  const tClamped = {} as Record<WeightKey, number>;
  for (const k of tunable) {
    tClamped[k] = Math.max(0, w[k]);
    tSum += tClamped[k];
  }

  const out = {} as Record<WeightKey, number>;
  for (const k of WEIGHT_KEYS) out[k] = tunableSet.has(k) ? 0 : Math.max(0, base[k]);
  for (const k of tunable) {
    out[k] = tSum > 0 ? (budget * tClamped[k]) / tSum : budget / tunable.length;
  }
  return out;
}

export interface SearchOptions {
  iterations?: number;
  step?: number;
  seed?: number;
  /** Restrict tuning to these signals (others stay at `base`). Default: all. */
  tunableKeys?: readonly WeightKey[];
}

export interface SearchResult {
  profile: ScoringProfile;
  fitness: number;
  baselineFitness: number;
  iterations: number;
}

/**
 * Random-perturbation hill-climb over the weight simplex (non-negative, sum to 1)
 * maximizing {@link fitness}. Deterministic for a given seed so runs are
 * reproducible. Only the 8 signal weights are tuned; thresholds/penalties (which
 * don't affect the rank-correlation objective) are inherited from `base`.
 */
export function searchWeights(
  samples: BacktestSample[],
  base: ScoringProfile = DEFAULT_PROFILE,
  opts: SearchOptions = {},
): SearchResult {
  const iterations = opts.iterations ?? 3000;
  const step = opts.step ?? 0.05;
  const tunable = opts.tunableKeys ?? WEIGHT_KEYS;
  let seed = (opts.seed ?? 12345) % 0x7fffffff;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  // A fully random point on the (masked) weight simplex — escapes plateaus.
  const randomWeights = (): Record<WeightKey, number> => {
    const w = { ...base.weights };
    for (const k of tunable) w[k] = rand();
    return normalizeMasked(w, base.weights, tunable);
  };

  // Start from base, re-projected onto the masked simplex (no-op when all tunable).
  const baselineFitness = fitness(samples, base);
  let bestWeights = normalizeMasked(base.weights, base.weights, tunable);
  let bestFitness = fitness(samples, { ...base, weights: bestWeights });

  for (let it = 0; it < iterations; it++) {
    // Mostly hill-climb from the best so far; periodically restart from a random
    // simplex point so the greedy search can't get trapped on a flat ridge.
    let weights: Record<WeightKey, number>;
    if (rand() < 0.2) {
      weights = randomWeights();
    } else {
      const candidate = { ...bestWeights };
      const k = tunable[Math.floor(rand() * tunable.length)];
      candidate[k] = candidate[k] + (rand() - 0.5) * 2 * step;
      weights = normalizeMasked(candidate, base.weights, tunable);
    }
    const f = fitness(samples, { ...base, weights });
    if (f > bestFitness) {
      bestFitness = f;
      bestWeights = weights;
    }
  }

  return {
    profile: { ...base, weights: bestWeights },
    fitness: bestFitness,
    baselineFitness,
    iterations,
  };
}

export interface LoadSamplesOptions {
  /** Which dataset to load. Defaults to 'live' so the full-model refinement is unaffected. */
  dataset?: "live" | "historical";
}

/**
 * Load matured, labeled samples: every matured outcome joined to its frozen
 * report payload. Done in two queries (robust to PostgREST embedding quirks).
 */
export async function loadSamples(opts: LoadSamplesOptions = {}): Promise<BacktestSample[]> {
  const dataset = opts.dataset ?? "live";
  const sb = supabaseServer();
  const { data: outcomes, error } = await sb
    .from("outcomes")
    .select("report_id, forward_return, measured_signals")
    .eq("matured", true)
    .eq("dataset", dataset)
    .not("forward_return", "is", null);
  if (error) throw new Error(`Failed to load outcomes: ${error.message}`);

  const rows = outcomes ?? [];
  if (rows.length === 0) return [];

  const reportIds = rows.map((r) => r.report_id as string);
  const { data: reports, error: repErr } = await sb
    .from("analysis_reports")
    .select("id, payload")
    .in("id", reportIds);
  if (repErr) throw new Error(`Failed to load reports: ${repErr.message}`);

  const payloadById = new Map<string, unknown>(
    (reports ?? []).map((r) => [r.id as string, r.payload]),
  );

  const samples: BacktestSample[] = [];
  for (const row of rows) {
    const payload = payloadById.get(row.report_id as string);
    const parsed = analysisReportSchema.safeParse(payload);
    if (!parsed.success) continue;
    const ret = (row as { forward_return: number | null }).forward_return;
    if (ret == null) continue;
    samples.push({
      report: parsed.data,
      forwardReturn: Number(ret),
      measuredSignals:
        (row as { measured_signals: string[] | null }).measured_signals ?? undefined,
    });
  }
  return samples;
}
