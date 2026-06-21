import type { TokenSummary } from "@/lib/providers/gmgn";

/** Parse an X handle (lowercased) from a twitter/x.com URL or `@handle`. Null if none. */
export function parseTwitterHandle(twitter: string | null): string | null {
  if (!twitter) return null;
  const url = twitter.match(/(?:x\.com|twitter\.com)\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i);
  if (url) return url[1].toLowerCase();
  const at = twitter.match(/^@?([A-Za-z0-9_]{1,15})$/);
  return at ? at[1].toLowerCase() : null;
}

/** A candidate insert row derived from a migrated token. */
export interface MigrationCandidate {
  handle: string;
  x_user_id: null;
  chain: string;
  token_address: string;
  display_name: string | null;
  discovery_note: string;
  status: "queued";
}

/**
 * Map a migrated token to a candidate row. The handle is the linked X username
 * when present (so the X analyzer scores the social layer); otherwise the symbol
 * (the X analyzer won't resolve it → `missing_social` flag downstream).
 */
export function migrationToCandidate(t: TokenSummary): MigrationCandidate {
  const handle = parseTwitterHandle(t.twitter);
  return {
    handle: handle ?? t.symbol ?? t.address,
    x_user_id: null,
    chain: t.chain,
    token_address: t.address,
    display_name: t.name || null,
    discovery_note: `Migrated${t.launchpad ? ` from ${t.launchpad}` : ""}${handle ? ` · @${handle}` : " · no X account"}`,
    status: "queued",
  };
}
