import { describe, it, expect } from "vitest";
import {
  forwardReturn,
  horizonDays,
  isMatured,
  MATURITY_DAYS,
} from "@/lib/scoring/outcome";

describe("forwardReturn", () => {
  it("prefers price on both sides", () => {
    expect(forwardReturn(1, 1000, 2, 5000)).toBeCloseTo(1, 9); // 2/1 - 1
  });

  it("falls back to market cap when a price is missing on either side", () => {
    expect(forwardReturn(null, 1000, null, 1500)).toBeCloseTo(0.5, 9);
    expect(forwardReturn(1, 1000, null, 1500)).toBeCloseTo(0.5, 9);
  });

  it("returns null when nothing is comparable", () => {
    expect(forwardReturn(null, null, 2, 5000)).toBeNull();
    expect(forwardReturn(0, null, 2, null)).toBeNull(); // non-positive baseline, no mcap
  });
});

describe("horizonDays / isMatured", () => {
  it("computes whole days elapsed", () => {
    const base = new Date("2026-01-01T00:00:00Z").toISOString();
    const now = new Date("2026-02-05T00:00:00Z").getTime(); // 35 days later
    expect(horizonDays(base, now)).toBe(35);
  });

  it("matures at the threshold", () => {
    expect(isMatured(MATURITY_DAYS - 1)).toBe(false);
    expect(isMatured(MATURITY_DAYS)).toBe(true);
  });
});
