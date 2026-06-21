import { describe, it, expect, beforeAll } from "vitest";
import { MockGmgnProvider, MOCK_TOKENS } from "@/lib/providers/gmgn";
import { buildOnchain, smartMoneyNetUsd, insiderRatio, priceFromSummary } from "@/lib/scoring/onchain";
import {
  computeScores,
  securityRedFlags,
  socialRedFlags,
  onchainSmartMoneyScore,
} from "@/lib/schema/scoring";
import { makeReport } from "@/lib/schema/fixtures";
import { analysisReportSchema, type OnChain } from "@/lib/schema/analysis";
import { toUnixSeconds } from "@/lib/providers/birdeye";

const gmgn = new MockGmgnProvider();

async function onchainFor(address: string) {
  const summary = (await gmgn.tokenInfo(address))!;
  const security = await gmgn.tokenSecurity(address);
  const traders = await gmgn.topTraders(address);
  return { summary, onchain: buildOnchain(summary, security, traders) };
}

describe("on-chain flow helpers", () => {
  it("computes smart-money net flow and insider ratio from traders", async () => {
    const gemTraders = await gmgn.topTraders(MOCK_TOKENS.GEM.address);
    const rugTraders = await gmgn.topTraders(MOCK_TOKENS.RUG.address);
    expect(smartMoneyNetUsd(gemTraders)).toBe(48_000);
    expect(insiderRatio(gemTraders)).toBe(0);
    expect(insiderRatio(rugTraders)).toBe(1);
  });

  it("builds a Zod-valid onchain section and report", async () => {
    const { summary, onchain } = await onchainFor(MOCK_TOKENS.GEM.address);
    const report = makeReport({ onchain, price: priceFromSummary(summary) });
    expect(() => analysisReportSchema.parse(report)).not.toThrow();
    expect(onchain.topHolderConcentration).toBe(0.22);
    expect(onchain.ageDays).toBeCloseTo(12, 0);
  });
});

describe("on-chain + social blend", () => {
  let gem: OnChain;
  let gemPrice: ReturnType<typeof priceFromSummary>;
  beforeAll(async () => {
    const r = await onchainFor(MOCK_TOKENS.GEM.address);
    gem = r.onchain;
    gemPrice = priceFromSummary(r.summary);
  });

  const tokenWithSocial = (smScore: number) =>
    makeReport({
      onchain: gem,
      price: gemPrice,
      account: { userId: "x123" }, // X resolved → social counts
      smartMoney: { score: smScore },
    });

  it("lets the X account move a token's smart-money signal (social always contributes)", () => {
    const weak = computeScores(tokenWithSocial(20)).smartMoney;
    const strong = computeScores(tokenWithSocial(80)).smartMoney;
    expect(strong).toBeGreaterThan(weak); // blend(0.6·90 + 0.4·social)
    expect(weak).toBeLessThan(onchainSmartMoneyScore(gem)); // weak X drags it below on-chain-only
  });

  it("ignores social and flags missing_social when no X account is linked", () => {
    const tokenOnly = makeReport({
      onchain: gem,
      price: gemPrice,
      account: { userId: null }, // no X resolved
      smartMoney: { score: 20 },
    });
    expect(computeScores(tokenOnly).smartMoney).toBe(onchainSmartMoneyScore(gem)); // 90, social ignored
    expect(socialRedFlags(tokenOnly).map((f) => f.code)).toContain("missing_social");
  });

  it("scores a gem validated on BOTH on-chain and X as High", () => {
    const report = makeReport({
      onchain: gem,
      price: gemPrice,
      account: { userId: "x123" },
      smartMoney: { score: 85 },
      engagement: { momentumScore: 80 },
      profile: { followerQuality: { score: 85 } },
      technicalDepth: { score: 70 },
      website: { score: 70 },
      github: { score: 60 },
      redFlags: [...securityRedFlags(gem)],
    });
    const s = computeScores(report);
    expect(s.earliness).toBe(90);
    expect(s.price).toBe(80);
    expect(s.verdict).toBe("High");
  });
});

describe("on-chain scoring", () => {
  it("flags and rejects a honeypot / high-concentration rug", async () => {
    const { summary, onchain } = await onchainFor(MOCK_TOKENS.RUG.address);
    const flags = securityRedFlags(onchain);
    const codes = flags.map((f) => f.code);
    expect(codes).toContain("honeypot");
    expect(codes).toContain("rug_risk");
    expect(codes).toContain("holder_concentration");
    expect(flags.find((f) => f.code === "honeypot")?.severity).toBe("high");

    const report = makeReport({ onchain, price: priceFromSummary(summary), redFlags: flags });
    expect(computeScores(report).verdict).toBe("Avoid");
  });

  it("falls back to social signals when onchain is absent (unchanged behavior)", () => {
    const report = makeReport({ smartMoney: { score: 77 } });
    expect(report.onchain).toBeUndefined();
    expect(computeScores(report).smartMoney).toBe(77);
  });
});

describe("Birdeye timestamp", () => {
  it("converts a date to whole UNIX seconds", () => {
    expect(toUnixSeconds(new Date("2025-01-01T00:00:00Z"))).toBe(1_735_689_600);
  });
});
