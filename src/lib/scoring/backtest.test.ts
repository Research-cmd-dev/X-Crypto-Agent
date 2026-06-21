import { describe, it, expect } from "vitest";
import {
  spearman,
  fitness,
  searchWeights,
  type BacktestSample,
} from "@/lib/scoring/backtest";
import { DEFAULT_PROFILE } from "@/lib/schema/scoring";
import { makeReport } from "@/lib/schema/fixtures";

describe("spearman", () => {
  it("is 1 for a perfectly monotonic relationship", () => {
    const pairs = [
      { score: 1, ret: 10 },
      { score: 2, ret: 20 },
      { score: 3, ret: 30 },
      { score: 4, ret: 40 },
    ];
    expect(spearman(pairs)).toBeCloseTo(1, 9);
  });

  it("is -1 for a perfectly inverse relationship", () => {
    const pairs = [
      { score: 1, ret: 40 },
      { score: 2, ret: 30 },
      { score: 3, ret: 20 },
      { score: 4, ret: 10 },
    ];
    expect(spearman(pairs)).toBeCloseTo(-1, 9);
  });

  it("handles ties without producing NaN", () => {
    const r = spearman([
      { score: 1, ret: 5 },
      { score: 1, ret: 5 },
      { score: 2, ret: 9 },
    ]);
    expect(Number.isNaN(r)).toBe(false);
  });

  it("returns 0 for degenerate input", () => {
    expect(spearman([{ score: 1, ret: 1 }])).toBe(0);
    expect(
      spearman([
        { score: 5, ret: 1 },
        { score: 5, ret: 2 },
      ]),
    ).toBe(0); // constant score series
  });
});

describe("fitness", () => {
  it("is high when a heavily-weighted signal predicts return", () => {
    const samples: BacktestSample[] = [
      [10, -0.5],
      [40, 0.0],
      [70, 0.5],
      [95, 2.0],
    ].map(([smart, ret]) => ({
      report: makeReport({ smartMoney: { score: smart, notes: "" } }),
      forwardReturn: ret,
    }));
    expect(fitness(samples, DEFAULT_PROFILE)).toBeGreaterThan(0.9);
  });
});

describe("searchWeights", () => {
  // website perfectly predicts return; smart money (the default's top weight) is
  // inversely related — so the default profile misranks and search must fix it.
  const samples: BacktestSample[] = [10, 40, 70, 95].map((w) => ({
    report: makeReport({
      smartMoney: { score: 100 - w, notes: "" },
      website: { score: w },
    }),
    forwardReturn: w,
  }));

  it("improves fitness when the default weights misrank, staying on the simplex", () => {
    const res = searchWeights(samples, DEFAULT_PROFILE, { iterations: 4000, seed: 1 });
    expect(res.baselineFitness).toBeLessThan(0); // default ranks them backwards
    expect(res.fitness).toBeGreaterThan(res.baselineFitness);
    expect(res.fitness).toBeGreaterThan(0.5);

    const weights = Object.values(res.profile.weights);
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    for (const w of weights) expect(w).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic for a fixed seed", () => {
    const a = searchWeights(samples, DEFAULT_PROFILE, { iterations: 1000, seed: 42 });
    const b = searchWeights(samples, DEFAULT_PROFILE, { iterations: 1000, seed: 42 });
    expect(a.profile.weights).toEqual(b.profile.weights);
    expect(a.fitness).toBe(b.fitness);
  });
});
