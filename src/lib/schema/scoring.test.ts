import { describe, it, expect } from "vitest";
import {
  computeScores,
  clampScore,
  priceContextScore,
  onchainScore,
  toVerdict,
  redFlagPenalty,
  isPenaltyExempt,
  DEFAULT_SCORING,
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
  it("applies a single flag at full weight", () => {
    expect(redFlagPenalty([{ severity: "high", code: "a", message: "" }])).toBe(12);
    expect(redFlagPenalty([{ severity: "med", code: "a", message: "" }])).toBe(5);
    expect(redFlagPenalty([{ severity: "low", code: "a", message: "" }])).toBe(2);
  });

  it("discounts additional flags (diminishing returns, strongest-first)", () => {
    // 12 + 5*0.6 + 2*0.36 = 15.72 -> 16
    expect(
      redFlagPenalty([
        { severity: "low", code: "c", message: "" },
        { severity: "high", code: "a", message: "" },
        { severity: "med", code: "b", message: "" },
      ]),
    ).toBe(16);
  });

  it("caps total drag so flag-stacking can't zero a strong project", () => {
    const tenHigh = Array.from({ length: 10 }, (_, i) => ({
      severity: "high" as const,
      code: `h${i}`,
      message: "",
    }));
    expect(redFlagPenalty(tenHigh)).toBeLessThanOrEqual(30);
  });

  it("exempts normal early-stage traits (pump.fun / anon team) from penalty", () => {
    expect(
      redFlagPenalty([
        { severity: "high", code: "pump_fun_token", message: "Bio CA ends in 'pump'." },
        { severity: "high", code: "anonymous_team", message: "No named founders disclosed." },
        { severity: "high", code: "key_person_risk", message: "One pseudonymous dev." },
      ]),
    ).toBe(0);
  });

  it("still penalizes genuine risk flags alongside exempt ones", () => {
    // pump.fun + anon are exempt; only no_code (high=12) counts.
    expect(
      redFlagPenalty([
        { severity: "high", code: "pump_fun_token", message: "pump.fun launch" },
        { severity: "high", code: "no_code", message: "No repo behind AI claims." },
      ]),
    ).toBe(12);
  });
});

describe("isPenaltyExempt", () => {
  it("matches pump.fun / bonding curve / anon, not real risks", () => {
    expect(isPenaltyExempt({ severity: "high", code: "pump_fun_token", message: "" })).toBe(true);
    expect(isPenaltyExempt({ severity: "high", code: "x", message: "pseudonymous solo dev" })).toBe(true);
    expect(isPenaltyExempt({ severity: "high", code: "no_code", message: "no repository" })).toBe(false);
  });
});

describe("computeScores config override", () => {
  it("lets a sweep zero out penalties without touching source", () => {
    const report = makeReport({ redFlags: [{ severity: "high", code: "no_code", message: "" }] });
    const base = computeScores(report);
    const noPenalty = computeScores(report, {
      ...DEFAULT_SCORING,
      penalty: { high: 0, med: 0, low: 0 },
    });
    expect(noPenalty.overall).toBeGreaterThanOrEqual(base.overall);
  });
});

describe("computeScores", () => {
  it("produces a high verdict for a strong project", () => {
    const report = makeReport({
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
    for (const k of ["profile", "website", "github", "engagement", "technicalDepth", "price", "overall"] as const) {
      expect(s[k]).toBeGreaterThanOrEqual(0);
      expect(s[k]).toBeLessThanOrEqual(100);
    }
  });
});

describe("onchainScore", () => {
  it("is neutral (50) with no on-chain data (pre-token or missing)", () => {
    expect(onchainScore({ holderCount: null, traders24h: null, trades24h: null, firstTradeAt: null, smartMoney: null, source: "none", notes: "" })).toBe(50);
  });
  it("rewards solid early holders + traders", () => {
    const oc = { holderCount: 4200, traders24h: 850, trades24h: 12000, firstTradeAt: null, smartMoney: null, source: "bitquery", notes: "" };
    expect(onchainScore(oc)).toBeGreaterThanOrEqual(70);
  });
  it("gives meaningful score even with only holders", () => {
    expect(onchainScore({ holderCount: 650, traders24h: null, trades24h: null, firstTradeAt: null, smartMoney: null, source: "bitquery", notes: "" })).toBeGreaterThan(35);
  });
});

describe("priceContextScore + full compute with onchain", () => {
  it("price is neutral pre-token, onchain contributes", () => {
    const report = makeReport({
      price: { token: null, marketCapUsd: null, volume24hUsd: null, priceUsd: null, source: "none", notes: "" },
      onchain: { holderCount: 3100, traders24h: 420, trades24h: 8000, firstTradeAt: "2026-06-01", smartMoney: null, source: "bitquery", notes: "" },
    });
    const s = computeScores(report);
    expect(s.price).toBe(50);
    expect(s.onchain).toBeGreaterThan(50);
    expect(s.overall).toBeGreaterThanOrEqual(45);
  });
});

describe("analysisReportSchema", () => {
  it("validates the fixture round-trip", () => {
    const report = makeReport();
    expect(() => analysisReportSchema.parse(report)).not.toThrow();
  });
});
