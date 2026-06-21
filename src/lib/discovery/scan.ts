import type { XProvider } from "@/lib/providers/x";
import { extractMentions } from "@/lib/extract";

/** A signal source to scan: a recent-search query, or a curated account whose mentions surface new projects. */
export interface SignalSource {
  id: string;
  kind: "query" | "account";
  value: string;
}

export interface DiscoveredCandidate {
  xUserId: string;
  handle: string;
  displayName: string | null;
  sourceId: string;
  note: string;
}

export interface ScanOptions {
  /** Tweets to pull per source. */
  perSource?: number;
  /** Cap mentioned handles resolved per curated account (rate-limit guard). */
  maxResolvePerAccount?: number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Default standalone sources — recent-search queries tuned for super-early
 * Solana / pump.fun launches in the AI / DePIN / agent space. (Production
 * discovery instead reads the `signal_sources` table; these are the fallback
 * used by `npm run scan`.)
 */
export const DEFAULT_SOURCES: SignalSource[] = [
  { id: "q-ai-launch", kind: "query", value: '(pumpfun OR "pump.fun" OR "fair launch" OR "stealth launch") (AI OR agent OR inference OR DePIN) -is:retweet lang:en' },
  { id: "q-ai-live", kind: "query", value: '("decentralized AI" OR "AI agent" OR "AI inference" OR DePIN) (launched OR live OR "CA:" OR mainnet) -is:retweet lang:en' },
  { id: "q-launch", kind: "query", value: '("just launched" OR "now live" OR "stealth launched") (protocol OR token OR network) (solana OR crypto OR onchain) -is:retweet lang:en' },
];

/** Scan a single source into the `found` map (deduped by X user id). */
export async function discoverFromSource(
  x: XProvider,
  source: SignalSource,
  found: Map<string, DiscoveredCandidate>,
  opts: ScanOptions = {},
): Promise<void> {
  const perSource = opts.perSource ?? 25;

  if (source.kind === "query") {
    const tweets = await x.searchRecent(source.value, { maxResults: perSource });
    for (const t of tweets) {
      if (!t.authorId || !t.authorUsername || found.has(t.authorId)) continue;
      found.set(t.authorId, {
        xUserId: t.authorId,
        handle: t.authorUsername,
        displayName: null,
        sourceId: source.id,
        note: `Matched query "${source.value.slice(0, 48)}…": ${t.text.replace(/\s+/g, " ").slice(0, 120)}`,
      });
    }
    return;
  }

  // kind === "account": scan a curated account's timeline for @mentions of new projects.
  const account = await x.getUserByHandle(source.value);
  if (!account) return;
  const tweets = await x.getUserTimeline(account.id, { maxResults: perSource });
  const handles = new Set<string>();
  for (const t of tweets) for (const h of extractMentions(t.text, 20)) handles.add(h.toLowerCase());

  let resolved = 0;
  const cap = opts.maxResolvePerAccount ?? 15;
  for (const handle of handles) {
    if (handle === account.username.toLowerCase() || resolved >= cap) continue;
    const user = await x.getUserByHandle(handle).catch(() => null);
    resolved++;
    if (!user || found.has(user.id)) continue;
    found.set(user.id, {
      xUserId: user.id,
      handle: user.username,
      displayName: user.name,
      sourceId: source.id,
      note: `Mentioned by @${account.username}`,
    });
  }
}

/** Scan all sources and return the deduped candidate set (no persistence). */
export async function scanSignalSources(
  x: XProvider,
  sources: SignalSource[],
  opts: ScanOptions = {},
): Promise<DiscoveredCandidate[]> {
  const found = new Map<string, DiscoveredCandidate>();
  for (const source of sources) {
    try {
      await discoverFromSource(x, source, found, opts);
    } catch (e) {
      opts.log?.("scan source failed", { source: source.value, error: String(e) });
    }
  }
  return [...found.values()];
}
