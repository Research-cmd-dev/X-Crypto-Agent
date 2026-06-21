import { describe, it, expect } from "vitest";
import { extractSolanaToken, reconcileByToken, type ResolvedCandidate } from "@/lib/discovery/token-link";

const MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

describe("extractSolanaToken", () => {
  it("pulls the mint from token-URL profile links", () => {
    expect(extractSolanaToken(null, [`https://pump.fun/coin/${MINT}`])).toBe(MINT);
    expect(extractSolanaToken(null, [`https://birdeye.so/token/${MINT}?chain=solana`])).toBe(MINT);
    expect(extractSolanaToken(null, [`https://solscan.io/token/${MINT}`])).toBe(MINT);
  });

  it("pulls a labeled contract address from the bio", () => {
    expect(extractSolanaToken(`gm. CA: ${MINT} 🚀`, [])).toBe(MINT);
    expect(extractSolanaToken(`contract ${MINT}`, [])).toBe(MINT);
  });

  it("returns null when there's no token reference (bare handles, websites)", () => {
    expect(extractSolanaToken("just a vibes account", ["https://myproject.xyz"])).toBeNull();
    expect(extractSolanaToken(null, [])).toBeNull();
    // DexScreener pair URLs are excluded (pair != mint)
    expect(extractSolanaToken(null, [`https://dexscreener.com/solana/${MINT}`])).toBeNull();
  });
});

describe("reconcileByToken", () => {
  const cand = (xUserId: string, tokenAddress: string | null): ResolvedCandidate => ({
    xUserId,
    handle: `h${xUserId}`,
    displayName: null,
    sourceId: "s1",
    note: "n",
    tokenAddress,
  });

  it("merges an account onto an existing migration token candidate", () => {
    const plan = reconcileByToken([cand("u1", MINT)], new Map([[MINT, "tok-cand-id"]]));
    expect(plan.inserts).toHaveLength(0);
    expect(plan.merges).toEqual([{ id: "tok-cand-id", xUserId: "u1", handle: "hu1", displayName: null }]);
  });

  it("inserts when the token is new or absent", () => {
    const plan = reconcileByToken([cand("u1", MINT), cand("u2", null)], new Map());
    expect(plan.merges).toHaveLength(0);
    expect(plan.inserts.map((c) => c.xUserId)).toEqual(["u1", "u2"]);
  });

  it("de-duplicates two accounts claiming the same mint in one batch", () => {
    const plan = reconcileByToken([cand("u1", MINT), cand("u2", MINT)], new Map());
    expect(plan.inserts).toHaveLength(1); // second is dropped, not a unique-constraint crash
    expect(plan.inserts[0].xUserId).toBe("u1");
  });
});
