import { describe, it, expect } from "vitest";
import {
  computeLaunchScore,
  rankLaunches,
  selectTopKForDeepDive,
  normalizeTop10Pct,
  DEFAULT_LAUNCH_SCORE,
  type LaunchFeatures,
} from "@/lib/schema/launch-score";

function base(over: Partial<LaunchFeatures> = {}): LaunchFeatures {
  return {
    mint: "Mint1111111111111111111111111111111111111",
    holders: null,
    traders24h: null,
    trades24h: null,
    liquidityUsd: null,
    marketCapUsd: null,
    volume24hUsd: null,
    mintRenounced: null,
    freezeRenounced: null,
    top10HolderPct: null,
    riskScore: null,
    smartMoneyCount: null,
    hasTwitter: false,
    followers: null,
    graduatedAt: null,
    sources: ["test"],
    ...over,
  };
}

describe("normalizeTop10Pct", () => {
  it("treats 0–1 as fraction", () => {
    expect(normalizeTop10Pct(0.42)).toBeCloseTo(42);
  });
  it("passes through percent values", () => {
    expect(normalizeTop10Pct(55)).toBe(55);
  });
});

describe("computeLaunchScore", () => {
  it("is neutral-ish when almost no data (not auto-zero)", () => {
    const r = computeLaunchScore(base());
    expect(r.vetoed).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(40);
    expect(r.score).toBeLessThanOrEqual(60);
  });

  it("ranks a strong launch above an empty shell", () => {
    const gem = computeLaunchScore(
      base({
        holders: 2500,
        traders24h: 400,
        liquidityUsd: 40_000,
        marketCapUsd: 200_000,
        volume24hUsd: 80_000,
        mintRenounced: true,
        freezeRenounced: true,
        top10HolderPct: 28,
        smartMoneyCount: 8,
        hasTwitter: true,
        followers: 800,
      }),
    );
    const shell = computeLaunchScore(
      base({
        holders: 25,
        traders24h: 2,
        liquidityUsd: 800,
        marketCapUsd: 8_000,
        volume24hUsd: 200,
        hasTwitter: false,
      }),
    );
    expect(gem.score).toBeGreaterThan(shell.score + 15);
    expect(gem.vetoed).toBe(false);
  });

  it("hard-vetoes extreme top-10 concentration", () => {
    const r = computeLaunchScore(
      base({
        holders: 2000,
        traders24h: 300,
        liquidityUsd: 50_000,
        top10HolderPct: 0.92, // fraction form
        mintRenounced: true,
      }),
    );
    expect(r.vetoed).toBe(true);
    expect(r.score).toBe(0);
    expect(r.vetoReasons.some((x) => x.startsWith("top10_"))).toBe(true);
  });

  it("hard-vetoes extreme risk score", () => {
    const r = computeLaunchScore(
      base({
        holders: 1000,
        riskScore: 9.5,
      }),
    );
    expect(r.vetoed).toBe(true);
    expect(r.score).toBe(0);
  });

  it("flags holder/follower divergence in social sub-score", () => {
    const divergent = computeLaunchScore(
      base({
        holders: 2800,
        hasTwitter: true,
        followers: 40,
        traders24h: 50,
        liquidityUsd: 20_000,
      }),
    );
    const aligned = computeLaunchScore(
      base({
        holders: 800,
        hasTwitter: true,
        followers: 600,
        traders24h: 50,
        liquidityUsd: 20_000,
      }),
    );
    expect(divergent.parts.social).toBeLessThan(aligned.parts.social);
  });

  it("does not require smart-money data to score well", () => {
    // Primary path can be ST-only (GMGN optional)
    const r = computeLaunchScore(
      base({
        holders: 1200,
        traders24h: 150,
        liquidityUsd: 25_000,
        marketCapUsd: 150_000,
        volume24hUsd: 40_000,
        hasTwitter: true,
        followers: 400,
        smartMoneyCount: null,
        riskScore: null,
        top10HolderPct: null,
      }),
    );
    expect(r.vetoed).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(50);
  });
});

describe("rankLaunches / selectTopKForDeepDive", () => {
  it("sorts by score and sinks vetoes", () => {
    const ranked = rankLaunches([
      base({ mint: "a", holders: 50 }),
      base({ mint: "b", holders: 2000, traders24h: 200, liquidityUsd: 30_000, hasTwitter: true }),
      base({ mint: "c", holders: 5000, top10HolderPct: 95 }),
    ]);
    expect(ranked[0].mint).toBe("b");
    expect(ranked[ranked.length - 1].mint).toBe("c");
    expect(ranked[ranked.length - 1].result.vetoed).toBe(true);
  });

  it("selects only non-vetoed above min score, limited by topK", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      base({
        mint: `m${i}`,
        holders: 100 + i * 100,
        traders24h: 20 + i * 10,
        liquidityUsd: 5_000 + i * 2_000,
        hasTwitter: true,
      }),
    );
    const top = selectTopKForDeepDive(many, { ...DEFAULT_LAUNCH_SCORE, topK: 5 });
    expect(top.length).toBeLessThanOrEqual(5);
    expect(top.every((x) => !x.result.vetoed)).toBe(true);
    expect(top.every((x) => x.result.score >= DEFAULT_LAUNCH_SCORE.minScoreForDeepDive)).toBe(
      true,
    );
  });
});
