import { describe, it, expect } from "vitest";
import {
  priceReturn,
  closeNear,
  computeOutcome,
  scoreDiscrimination,
  formatPct,
} from "@/lib/schema/outcomes";

describe("priceReturn", () => {
  it("computes simple returns", () => {
    expect(priceReturn(100, 150)).toBeCloseTo(0.5);
    expect(priceReturn(100, 50)).toBeCloseTo(-0.5);
  });
  it("returns null on bad inputs", () => {
    expect(priceReturn(null, 10)).toBeNull();
    expect(priceReturn(0, 10)).toBeNull();
    expect(priceReturn(10, null)).toBeNull();
  });
});

describe("closeNear", () => {
  const candles = [
    { unixTime: 1000, c: 1 },
    { unixTime: 2000, c: 2 },
    { unixTime: 3000, c: 3 },
  ];
  it("picks closest candle within window", () => {
    expect(closeNear(candles, 2100, 500)).toBe(2);
  });
  it("returns null when outside window", () => {
    expect(closeNear(candles, 9000, 100)).toBeNull();
  });
});

describe("computeOutcome", () => {
  it("labels strong / rugged / weak", () => {
    const t0 = { priceUsd: 1 };
    expect(computeOutcome(t0, { h24: { priceUsd: 2 } }).label).toBe("strong");
    expect(computeOutcome(t0, { h24: { priceUsd: 1.1 } }).label).toBe("ok");
    expect(computeOutcome(t0, { h24: { priceUsd: 0.5 } }).label).toBe("weak");
    expect(computeOutcome(t0, { h24: { priceUsd: 0.05 } }).label).toBe("rugged");
    expect(computeOutcome(t0, {}).label).toBe("unknown");
  });

  it("fills multi-horizon returns", () => {
    const o = computeOutcome(
      { priceUsd: 1 },
      { h1: { priceUsd: 1.2 }, h6: { priceUsd: 0.9 }, h24: { priceUsd: 1.5 } },
    );
    expect(o.ret1h).toBeCloseTo(0.2);
    expect(o.ret6h).toBeCloseTo(-0.1);
    expect(o.ret24h).toBeCloseTo(0.5);
    expect(o.success24h).toBe(true);
    expect(o.strong24h).toBe(true);
  });
});

describe("scoreDiscrimination", () => {
  it("shows positive gap when high scores map to ok/strong", () => {
    const d = scoreDiscrimination([
      { launchScore: 80, label: "strong" },
      { launchScore: 70, label: "ok" },
      { launchScore: 20, label: "rugged" },
      { launchScore: 25, label: "rugged" },
    ]);
    expect(d.gap).not.toBeNull();
    expect(d.gap!).toBeGreaterThan(40);
  });
});

describe("formatPct", () => {
  it("formats", () => {
    expect(formatPct(0.123)).toBe("+12.3%");
    expect(formatPct(-0.5)).toBe("-50.0%");
    expect(formatPct(null)).toBe("?");
  });
});
