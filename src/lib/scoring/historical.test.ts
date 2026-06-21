import { describe, it, expect } from "vitest";
import {
  buildHistoricalReport,
  historySourceKind,
  estimateMcap,
  MEASURED_SIGNALS,
} from "@/lib/scoring/historical";
import { toCoinGeckoDate } from "@/lib/providers/price";
import { analysisReportSchema } from "@/lib/schema/analysis";
import { computeScores, priceContextScore } from "@/lib/schema/scoring";

describe("toCoinGeckoDate", () => {
  it("formats as dd-mm-yyyy in UTC", () => {
    expect(toCoinGeckoDate(new Date("2024-09-05T12:00:00Z"))).toBe("05-09-2024");
    expect(toCoinGeckoDate(new Date("2024-01-01T00:00:00Z"))).toBe("01-01-2024");
  });
});

describe("buildHistoricalReport", () => {
  const createdAt = new Date(Date.now() - 60 * 86_400_000).toISOString(); // ~2 months old
  const report = buildHistoricalReport(
    { handle: "proj", token: "PROJ", createdAt },
    { priceUsd: 0.01, marketCapUsd: 2_000_000, volume24hUsd: 300_000 },
  );

  it("produces a Zod-valid report", () => {
    expect(() => analysisReportSchema.parse(report)).not.toThrow();
  });

  it("fills the reconstructable fields with as-of-T data", () => {
    expect(report.account.createdAt).toBe(createdAt);
    expect(report.price.token).toBe("PROJ");
    expect(report.price.marketCapUsd).toBe(2_000_000);
    expect(report.price.source).toBe("coingecko-history");
  });

  it("scores price from the real T snapshot (liquidity 0.15 → 80)", () => {
    expect(computeScores(report).price).toBe(80);
    expect(computeScores(report).price).toBe(priceContextScore(report.price));
  });

  it("earliness reflects a young, microcap entry (age + mcap, neutral followers)", () => {
    // age(~2mo)=90, followerBand(null)=50, mcapBand(2M)=90 → 0.4*90+0.3*50+0.3*90 = 78
    expect(computeScores(report).earliness).toBe(78);
  });

  it("only claims earliness + price as measured", () => {
    expect([...MEASURED_SIGNALS]).toEqual(["earliness", "price"]);
  });
});

describe("historical price source selection", () => {
  it("routes Solana mints to Birdeye and everything else to CoinGecko", () => {
    expect(historySourceKind({ chain: "sol", tokenAddress: "mint123" })).toBe("birdeye");
    expect(historySourceKind({ tokenAddress: "mint123" })).toBe("birdeye"); // address, no coingecko id
    expect(historySourceKind({ coingeckoId: "bitcoin" })).toBe("coingecko");
    expect(historySourceKind({ coingeckoId: "wif", tokenAddress: "mint123" })).toBe("coingecko");
    expect(historySourceKind({})).toBe("coingecko");
  });

  it("estimates market cap from price × supply", () => {
    expect(estimateMcap(0.01, 1_000_000_000)).toBe(10_000_000);
    expect(estimateMcap(null, 1_000_000_000)).toBeNull();
    expect(estimateMcap(0.01, undefined)).toBeNull();
  });
});

describe("buildHistoricalReport (Solana on-chain entry)", () => {
  it("uses token age for earliness and tags the on-chain section", () => {
    const report = buildHistoricalReport(
      {
        handle: "solmeme",
        token: "MEME",
        createdAt: null,
        source: "birdeye-history",
        onchain: { chain: "sol", tokenAddress: "mint123", ageDays: 10 },
      },
      { priceUsd: 0.01, marketCapUsd: 2_000_000, volume24hUsd: null },
    );
    expect(report.onchain?.tokenAddress).toBe("mint123");
    expect(report.price.source).toBe("birdeye-history");
    // token age 10d → 90, holders null → 50, mcap 2M → 90 ⇒ 0.4·90+0.3·50+0.3·90 = 78
    expect(computeScores(report).earliness).toBe(78);
  });
});
