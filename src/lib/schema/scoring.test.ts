import { describe, it, expect } from "vitest";
import {
  computeScores,
  clampScore,
  priceContextScore,
  toVerdict,
  redFlagPenalty,
  earlinessScore,
  explainScore,
  ALPHA_WEIGHTS,
  DEFAULT_PROFILE,
  scoringProfileSchema,
  type ScoringProfile,
} from "@/lib/schema/scoring";
import { analysisReportSchema } from "@/lib/schema/analysis";
import { makeReport } from "@/lib/schema/fixtures";

describe("clampScore", () => {
  it("clamps and rounds into [0,100]", () => {
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(150)).toBe(100);
    expect(clampScore(72.6)).toBe(73);
    expect(clampScore(null)).toBe(0);
    expect(clampScore(NaN)).toBe(0);
  });
});

describe("priceContextScore", () => {
  it("is neutral (50) for pre-token projects", () => {
    expect(priceContextScore(makeReport().price)).toBe(50);
  });
  it("rewards healthy liquidity", () => {
    const price = { token: "EXMPL", marketCapUsd: 1_000_000, volume24hUsd: 200_000, priceUsd: 0.01, source: "coingecko", notes: "" };
    expect(priceContextScore(price)).toBe(80);
  });
  it("penalizes very thin liquidity", () => {
    const price = { token: "EXMPL", marketCapUsd: 10_000_000, volume24hUsd: 1_000, priceUsd: 0.1, source: "coingecko", notes: "" };
    expect(priceContextScore(price)).toBe(25);
  });
});

describe("toVerdict", () => {
  it("maps thresholds", () => {
    expect(toVerdict(85)).toBe("High");
    expect(toVerdict(70)).toBe("High");
    expect(toVerdict(55)).toBe("Monitor");
    expect(toVerdict(40)).toBe("Monitor");
    expect(toVerdict(39)).toBe("Avoid");
  });
});

describe("redFlagPenalty", () => {
  it("sums severities", () => {
    expect(
      redFlagPenalty([
        { severity: "high", code: "a", message: "" },
        { severity: "med", code: "b", message: "" },
        { severity: "low", code: "c", message: "" },
      ]),
    ).toBe(25);
  });
});

describe("computeScores", () => {
  it("produces a high verdict for a strong project with smart-money backing", () => {
    const report = makeReport({
      smartMoney: { score: 90, notes: "" },
      profile: { followerQuality: { score: 90, notes: "" } },
      website: { score: 90 },
      github: { score: 85 },
      engagement: { momentumScore: 80 },
      technicalDepth: { score: 80 },
    });
    const s = computeScores(report);
    expect(s.overall).toBeGreaterThanOrEqual(70);
    expect(s.verdict).toBe("High");
  });

  it("drops to Avoid when high-severity red flags pile up", () => {
    const report = makeReport({
      profile: { followerQuality: { score: 60, notes: "" } },
      website: { score: 55 },
      github: { score: 50 },
      engagement: { momentumScore: 50 },
      technicalDepth: { score: 45 },
      redFlags: [
        { severity: "high", code: "fake_followers", message: "" },
        { severity: "high", code: "no_github", message: "" },
      ],
    });
    const s = computeScores(report);
    expect(s.overall).toBeLessThan(40);
    expect(s.verdict).toBe("Avoid");
  });

  it("only ever emits valid sub-scores in [0,100]", () => {
    const s = computeScores(makeReport());
    for (const k of ["smartMoney", "earliness", "profile", "website", "github", "engagement", "technicalDepth", "price", "overall"] as const) {
      expect(s[k]).toBeGreaterThanOrEqual(0);
      expect(s[k]).toBeLessThanOrEqual(100);
    }
  });

  it("weights smart money highest — it dominates the overall", () => {
    const withSmart = computeScores(makeReport({ smartMoney: { score: 100, notes: "" } }));
    const without = computeScores(makeReport({ smartMoney: { score: 0, notes: "" } }));
    // A full-vs-zero swing on smart money should move the overall by ~28 points.
    expect(withSmart.overall - without.overall).toBeGreaterThanOrEqual(25);
  });
});

describe("scoring profiles", () => {
  it("DEFAULT_PROFILE is the implicit default (no behavior change)", () => {
    const r = makeReport({ smartMoney: { score: 80, notes: "" } });
    expect(computeScores(r)).toEqual(computeScores(r, DEFAULT_PROFILE));
    expect(scoringProfileSchema.safeParse(DEFAULT_PROFILE).success).toBe(true);
  });

  it("honors custom weights", () => {
    const r = makeReport({ website: { score: 100 }, smartMoney: { score: 0, notes: "" } });
    const allWebsite: ScoringProfile = {
      weights: {
        smartMoney: 0,
        engagement: 0,
        earliness: 0,
        profile: 0,
        technicalDepth: 0,
        website: 1,
        github: 0,
        price: 0,
      },
      thresholds: { high: 70, monitor: 40 },
      penalties: { high: 15, med: 7, low: 3 },
    };
    expect(computeScores(r, allWebsite).overall).toBe(100);
  });
});

describe("ALPHA_WEIGHTS", () => {
  it("sum to 1.0", () => {
    const total = Object.values(ALPHA_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1.0, 9);
  });
  it("rank smart money as the single largest weight", () => {
    const max = Math.max(...Object.values(ALPHA_WEIGHTS));
    expect(ALPHA_WEIGHTS.smartMoney).toBe(max);
  });
});

describe("earlinessScore", () => {
  it("rewards a small, pre-token, recently-created account over a large mature one", () => {
    const recent = new Date(Date.now() - 60 * 86_400_000).toISOString(); // ~2 months old
    const early = earlinessScore(
      makeReport({
        account: { createdAt: recent },
        profile: { followerCount: 8000 },
        price: { token: null, marketCapUsd: null },
      }),
    );
    const late = earlinessScore(
      makeReport({
        account: { createdAt: "2019-01-01" },
        profile: { followerCount: 2_000_000 },
        price: { token: "BIG", marketCapUsd: 5_000_000_000 },
      }),
    );
    expect(early).toBeGreaterThan(late);
    expect(early).toBeGreaterThanOrEqual(80);
  });
});

describe("explainScore", () => {
  it("returns contributions sorted by points with a headline and matching overall", () => {
    const report = makeReport({ smartMoney: { score: 95, notes: "" } });
    const ex = explainScore(report);
    expect(ex.contributions).toHaveLength(8);
    // Sorted high → low by points.
    for (let i = 1; i < ex.contributions.length; i++) {
      expect(ex.contributions[i - 1].points).toBeGreaterThanOrEqual(ex.contributions[i].points);
    }
    // Smart money should be the top contributor here.
    expect(ex.contributions[0].key).toBe("smartMoney");
    expect(ex.overall).toBe(computeScores(report).overall);
    expect(ex.headline).toContain(`${ex.overall}`);
  });

  it("lists red-flag penalties", () => {
    const report = makeReport({
      redFlags: [{ severity: "high", code: "anon_team", message: "" }],
    });
    const ex = explainScore(report);
    expect(ex.penalties).toEqual([{ code: "anon_team", severity: "high", points: 15 }]);
  });
});

describe("analysisReportSchema", () => {
  it("validates the fixture round-trip", () => {
    const report = makeReport();
    expect(() => analysisReportSchema.parse(report)).not.toThrow();
  });
});
