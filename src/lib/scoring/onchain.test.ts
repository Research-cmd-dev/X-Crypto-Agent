import { describe, it, expect } from "vitest";
import { MockGmgnProvider, MOCK_TOKENS } from "@/lib/providers/gmgn";
import { buildOnchain, smartMoneyNetUsd, insiderRatio, priceFromSummary } from "@/lib/scoring/onchain";
import { computeScores, securityRedFlags } from "@/lib/schema/scoring";
import { makeReport } from "@/lib/schema/fixtures";
import { analysisReportSchema } from "@/lib/schema/analysis";
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
    expect(smartMoneyNetUsd(gemTraders)).toBe(48_000); // 30k + 18k bought, 0 sold
    expect(insiderRatio(gemTraders)).toBe(0); // no insider/bundler/sniper
    expect(insiderRatio(rugTraders)).toBe(1); // all top holders are insiders
  });

  it("builds a Zod-valid onchain section and report", async () => {
    const { summary, onchain } = await onchainFor(MOCK_TOKENS.GEM.address);
    const report = makeReport({ onchain, price: priceFromSummary(summary) });
    expect(() => analysisReportSchema.parse(report)).not.toThrow();
    expect(onchain.topHolderConcentration).toBe(0.22);
    expect(onchain.ageDays).toBeCloseTo(12, 0);
  });
});

describe("on-chain scoring", () => {
  it("scores a smart-money microcap gem as High", async () => {
    const { summary, onchain } = await onchainFor(MOCK_TOKENS.GEM.address);
    const report = makeReport({
      onchain,
      price: priceFromSummary(summary),
      redFlags: securityRedFlags(onchain),
    });
    const s = computeScores(report);
    expect(s.smartMoney).toBe(90); // 9 smart wallets + positive net flow
    expect(s.earliness).toBe(90); // young + good distribution + microcap
    expect(s.price).toBe(80); // liquidity 0.2
    expect(s.verdict).toBe("High");
  });

  it("flags and rejects a honeypot / high-concentration rug", async () => {
    const { summary, onchain } = await onchainFor(MOCK_TOKENS.RUG.address);
    const flags = securityRedFlags(onchain);
    const codes = flags.map((f) => f.code);
    expect(codes).toContain("honeypot");
    expect(codes).toContain("rug_risk");
    expect(codes).toContain("holder_concentration");
    expect(flags.find((f) => f.code === "honeypot")?.severity).toBe("high");

    const report = makeReport({ onchain, price: priceFromSummary(summary), redFlags: flags });
    const s = computeScores(report);
    expect(s.smartMoney).toBe(20); // no smart money
    expect(s.verdict).toBe("Avoid");
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
