// Solana base58 address (mints are 32–44 chars, no 0/O/I/l).
const BASE58 = "[1-9A-HJ-NP-Za-km-z]{32,44}";

// High-confidence token-URL patterns where the captured address IS the mint
// (DexScreener is intentionally excluded — its /solana/<addr> is a *pair*, not a mint).
const TOKEN_URL_RES = [
  new RegExp(`pump\\.fun/(?:coin/)?(${BASE58})`, "i"),
  new RegExp(`birdeye\\.so/token/(${BASE58})`, "i"),
  new RegExp(`gmgn\\.ai/sol/token/(${BASE58})`, "i"),
  new RegExp(`solscan\\.io/token/(${BASE58})`, "i"),
];

// A contract address explicitly labeled in the bio, e.g. "CA: <mint>".
const LABELED_CA_RE = new RegExp(`(?:\\bca\\b|contract|mint)\\s*[:=]?\\s*(${BASE58})`, "i");

/**
 * Resolve a Solana token mint from an X account's bio + profile links — projects
 * almost always post their contract address there. Conservative on purpose
 * (token URLs + a labeled CA only) so we don't mistake a wallet address for a
 * mint; a false negative just leaves the candidate social-only (the previous
 * behavior), and a stray address is harmless (the on-chain analyzer no-ops if
 * GMGN has no data for it). Returns the mint or null.
 */
export function extractSolanaToken(bio: string | null, urls: string[] = []): string | null {
  const haystacks = [...urls, bio ?? ""];
  for (const h of haystacks) {
    for (const re of TOKEN_URL_RES) {
      const m = h.match(re);
      if (m) return m[1];
    }
  }
  if (bio) {
    const labeled = bio.match(LABELED_CA_RE);
    if (labeled) return labeled[1];
  }
  return null;
}

/** An account candidate surfaced by the X scanner, with any resolved token. */
export interface ResolvedCandidate {
  xUserId: string;
  handle: string;
  displayName: string | null;
  sourceId: string;
  note: string;
  tokenAddress: string | null;
}

export interface ReconcilePlan {
  /** New candidates to insert (account, with token fields when resolved). */
  inserts: ResolvedCandidate[];
  /** Existing token candidates (migration funnel) to attach this account onto. */
  merges: { id: string; xUserId: string; handle: string; displayName: string | null }[];
}

/**
 * Decide insert-vs-merge for freshly discovered accounts: if an account resolved
 * a token that the migration funnel already created a candidate for, merge the
 * account identity onto that row instead of inserting a duplicate; otherwise
 * insert. De-duplicates tokens within the batch so two accounts shilling the
 * same mint don't collide on `unique(chain, token_address)`. Pure for testing.
 */
export function reconcileByToken(
  fresh: ResolvedCandidate[],
  existingByToken: Map<string, string>,
): ReconcilePlan {
  const inserts: ResolvedCandidate[] = [];
  const merges: ReconcilePlan["merges"] = [];
  const claimed = new Set<string>();

  for (const c of fresh) {
    if (c.tokenAddress) {
      if (claimed.has(c.tokenAddress)) continue; // another fresh row already took this mint
      claimed.add(c.tokenAddress);
      const existingId = existingByToken.get(c.tokenAddress);
      if (existingId) {
        merges.push({ id: existingId, xUserId: c.xUserId, handle: c.handle, displayName: c.displayName });
        continue;
      }
    }
    inserts.push(c);
  }
  return { inserts, merges };
}
