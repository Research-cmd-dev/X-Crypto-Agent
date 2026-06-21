import { task, schedules, logger } from "@trigger.dev/sdk/v3";
import { supabaseServer } from "@/lib/supabase/server";
import { getXProvider, type XProvider } from "@/lib/providers/x";
import { mapLimit } from "@/lib/util/fetch";
import { extractSolanaToken, reconcileByToken } from "@/lib/discovery/token-link";
import type { SignalSourceRow } from "@/lib/supabase/types";
import { analyzeCandidateTask } from "@/trigger/analyze-candidate";

interface DiscoveredCandidate {
  xUserId: string;
  handle: string;
  displayName: string | null;
  sourceId: string;
  note: string;
  /** Solana mint resolved from the account's bio/links (null if none found). */
  tokenAddress: string | null;
}

const MENTION_RE = /@([A-Za-z0-9_]{1,15})/g;

function parseMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) out.add(m[1].toLowerCase());
  return [...out];
}

/** Discover candidates for a single signal source. */
async function discoverFromSource(
  x: XProvider,
  source: SignalSourceRow,
  found: Map<string, DiscoveredCandidate>,
): Promise<void> {
  if (source.kind === "query") {
    const tweets = await x.searchRecent(source.value, { maxResults: 25 });
    for (const t of tweets) {
      if (!t.authorId || !t.authorUsername) continue;
      if (!found.has(t.authorId)) {
        found.set(t.authorId, {
          xUserId: t.authorId,
          handle: t.authorUsername,
          displayName: null,
          sourceId: source.id,
          note: `Matched query "${source.value}": ${t.text.slice(0, 120)}`,
          tokenAddress: extractSolanaToken(t.text, t.urls),
        });
      }
    }
    return;
  }

  // kind === "account": scan a curated account's timeline for @mentions of new projects.
  const account = await x.getUserByHandle(source.value);
  if (!account) return;
  const tweets = await x.getUserTimeline(account.id, { maxResults: 25 });
  const handles = new Set<string>();
  for (const t of tweets) for (const h of parseMentions(t.text)) handles.add(h);

  // Resolve mentioned handles with bounded concurrency (cached + rate-limited).
  const toResolve = [...handles].filter((h) => h !== account.username.toLowerCase());
  const users = await mapLimit(toResolve, 4, (handle) =>
    x.getUserByHandle(handle).catch(() => null),
  );

  for (const user of users) {
    if (!user || found.has(user.id)) continue;
    found.set(user.id, {
      xUserId: user.id,
      handle: user.username,
      displayName: user.name,
      sourceId: source.id,
      note: `Mentioned by @${account.username}`,
      tokenAddress: extractSolanaToken(user.description, user.urls),
    });
  }
}

/**
 * Core discovery routine: scan all active signal sources, dedupe against
 * existing candidates, insert new ones, and fan out analysis jobs.
 */
export async function runDiscovery(x: XProvider = getXProvider()): Promise<{
  scanned: number;
  inserted: number;
}> {
  const sb = supabaseServer();

  const { data: sources, error } = await sb
    .from("signal_sources")
    .select("*")
    .eq("active", true);
  if (error) throw new Error(`Failed to load signal_sources: ${error.message}`);

  const found = new Map<string, DiscoveredCandidate>();
  for (const source of (sources ?? []) as SignalSourceRow[]) {
    try {
      await discoverFromSource(x, source, found);
    } catch (e) {
      logger.warn("discovery source failed", {
        source: source.value,
        error: String(e),
      });
    }
  }

  if (found.size === 0) return { scanned: 0, inserted: 0 };

  // Dedupe against existing candidates by x_user_id.
  const ids = [...found.keys()];
  const { data: existing } = await sb
    .from("candidates")
    .select("x_user_id")
    .in("x_user_id", ids);
  const existingIds = new Set((existing ?? []).map((r) => r.x_user_id as string));

  const fresh = [...found.values()].filter((c) => !existingIds.has(c.xUserId));
  if (fresh.length === 0) return { scanned: found.size, inserted: 0 };

  // Reconcile against existing TOKEN candidates: if the migration funnel already
  // created a row for an account's resolved token, attach the account onto it
  // instead of inserting a duplicate.
  const freshTokens = fresh.map((c) => c.tokenAddress).filter((t): t is string => Boolean(t));
  const existingByToken = new Map<string, string>();
  if (freshTokens.length > 0) {
    const { data: tokRows } = await sb
      .from("candidates")
      .select("id, token_address")
      .in("token_address", freshTokens);
    for (const r of tokRows ?? []) existingByToken.set(r.token_address as string, r.id as string);
  }
  const { inserts, merges } = reconcileByToken(fresh, existingByToken);

  const triggerIds: string[] = [];

  for (const m of merges) {
    const { error } = await sb
      .from("candidates")
      .update({ x_user_id: m.xUserId, handle: m.handle, display_name: m.displayName, status: "queued" })
      .eq("id", m.id);
    if (error) {
      logger.warn("candidate merge failed", { id: m.id, error: error.message });
      continue;
    }
    triggerIds.push(m.id);
  }

  if (inserts.length > 0) {
    const { data: inserted, error: insErr } = await sb
      .from("candidates")
      .insert(
        inserts.map((c) => ({
          x_user_id: c.xUserId,
          handle: c.handle,
          display_name: c.displayName,
          chain: c.tokenAddress ? "sol" : null,
          token_address: c.tokenAddress,
          source_id: c.sourceId,
          discovery_note: c.note,
          status: "queued",
        })),
      )
      .select("id");
    if (insErr) throw new Error(`Failed to insert candidates: ${insErr.message}`);
    for (const r of inserted ?? []) triggerIds.push(r.id as string);
  }

  if (triggerIds.length > 0) {
    await analyzeCandidateTask.batchTrigger(
      triggerIds.map((candidateId) => ({ payload: { candidateId } })),
    );
  }

  logger.info("discovery complete", {
    scanned: found.size,
    inserted: inserts.length,
    merged: merges.length,
  });
  return { scanned: found.size, inserted: inserts.length };
}

/** Manually-triggerable discovery task (used by the dashboard API route). */
export const discoveryTask = task({
  id: "discovery",
  maxDuration: 600,
  run: async () => runDiscovery(),
});

/** Scheduled discovery — every 6 hours by default. */
export const discoverySchedule = schedules.task({
  id: "discovery-schedule",
  cron: "0 */6 * * *",
  run: async () => runDiscovery(),
});
