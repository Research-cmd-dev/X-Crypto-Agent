import { describe, it, expect } from "vitest";
import { parseTwitterHandle, migrationToCandidate } from "@/lib/discovery/migration";
import { MOCK_TOKENS } from "@/lib/providers/gmgn";

describe("parseTwitterHandle", () => {
  it("extracts a handle from x.com / twitter.com URLs and @handles", () => {
    expect(parseTwitterHandle("https://x.com/gemcoin")).toBe("gemcoin");
    expect(parseTwitterHandle("https://twitter.com/GemCoin")).toBe("gemcoin");
    expect(parseTwitterHandle("@GemCoin")).toBe("gemcoin");
    expect(parseTwitterHandle("https://x.com/gemcoin/status/123")).toBe("gemcoin");
  });

  it("returns null for missing or non-profile URLs", () => {
    expect(parseTwitterHandle(null)).toBeNull();
    expect(parseTwitterHandle("https://gemcoin.xyz")).toBeNull();
  });
});

describe("migrationToCandidate", () => {
  it("uses the linked X handle as the candidate handle", () => {
    const c = migrationToCandidate(MOCK_TOKENS.GEM);
    expect(c.handle).toBe("gemcoin");
    expect(c.token_address).toBe(MOCK_TOKENS.GEM.address);
    expect(c.chain).toBe("sol");
    expect(c.x_user_id).toBeNull();
    expect(c.discovery_note).toContain("@gemcoin");
  });

  it("falls back to the symbol and flags no-X when there's no linked account", () => {
    const c = migrationToCandidate(MOCK_TOKENS.RUG);
    expect(c.handle).toBe("RUG"); // symbol fallback
    expect(c.discovery_note).toContain("no X account");
  });
});
