import { describe, it, expect } from "vitest";
import {
  evaluateConfig,
  gridSearchWeights,
  makeSyntheticLabeledLaunches,
  normalizeWeights,
  pairwiseRankCorr,
  isSuccess,
  parseLabeledLine,
  metricsScore,
} from "@/lib/schema/launch-calibrate";
import { DEFAULT_LAUNCH_SCORE } from "@/lib/schema/launch-score";

describe("normalizeWeights", () => {
  it("sums to 1", () => {
    const w = normalizeWeights({
      traction: 2,
      safety: 2,
      smartMoney: 2,
      market: 2,
      social: 2,
    });
    const sum = w.traction + w.safety + w.smartMoney + w.market + w.social;
    expect(sum).toBeCloseTo(1, 5);
  });
});

describe("pairwiseRankCorr", () => {
  it("is 1 for perfect agreement", () => {
    expect(pairwiseRankCorr([3, 2, 1], [30, 20, 10])).toBeCloseTo(1);
  });
  it("is -1 for reverse", () => {
    expect(pairwiseRankCorr([1, 2, 3], [30, 20, 10])).toBeCloseTo(-1);
  });
});

describe("isSuccess / parseLabeledLine", () => {
  it("prefers label over loose success24h", () => {
    expect(isSuccess({ features: {} as any, success24h: true, label: "rugged" })).toBe(
      false,
    );
    expect(isSuccess({ features: {} as any, ret24h: 0.1 })).toBe(true);
    expect(isSuccess({ features: {} as any, ret24h: -0.2 })).toBe(false);
  });
  it("parses backfill-shaped rows", () => {
    const row = parseLabeledLine({
      mint: "x",
      features: {
        mint: "x",
        holders: 100,
        traders24h: null,
        trades24h: null,
        liquidityUsd: 5000,
        marketCapUsd: 50_000,
        volume24hUsd: 10_000,
        mintRenounced: true,
        freezeRenounced: true,
        top10HolderPct: 30,
        riskScore: 3,
        smartMoneyCount: 2,
        hasTwitter: true,
        followers: 200,
        graduatedAt: null,
      },
      outcome: { ret1h: 0, ret6h: 0, ret24h: 0.2, success24h: true, strong24h: false, label: "ok" },
    });
    expect(row?.features.holders).toBe(100);
    expect(isSuccess(row!)).toBe(true);
  });
  it("rejects rows without features", () => {
    expect(parseLabeledLine({ mint: "x", launchScore: 50 })).toBeNull();
  });
});

describe("evaluateConfig + gridSearch on synthetic", () => {
  const rows = makeSyntheticLabeledLaunches(80, 7);

  it("baseline has positive lift or gap on synthetic signal", () => {
    const m = evaluateConfig(rows, DEFAULT_LAUNCH_SCORE, { k: 10 });
    expect(m.n).toBe(80);
    expect(m.nSuccess).toBeGreaterThan(5);
    // With correlated synthetic data, default scorer should not be useless
    expect(m.gap == null || m.gap > 0 || (m.liftTopDecile ?? 0) >= 1).toBe(true);
  });

  it("grid search finds config at least as good as baseline", () => {
    const { baseline, bestMetrics, tried } = gridSearchWeights(rows, {
      k: 10,
      step: 0.25, // coarse for fast tests
    });
    expect(tried).toBeGreaterThan(10);
    expect(metricsScore(bestMetrics)).toBeGreaterThanOrEqual(metricsScore(baseline) - 1e-6);
  });

  it("precision@K is defined", () => {
    const m = evaluateConfig(rows, DEFAULT_LAUNCH_SCORE, { k: 8 });
    expect(m.precisionAtK).not.toBeNull();
    expect(m.precisionAtK!).toBeGreaterThanOrEqual(0);
    expect(m.precisionAtK!).toBeLessThanOrEqual(1);
  });
});
