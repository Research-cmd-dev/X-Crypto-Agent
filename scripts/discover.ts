/**
 * Unified discovery — combine the X search and the on-chain migration search by
 * joining on the X-handle ↔ contract-address link. Auto mode (`--loop N`) runs N
 * iterations, rotating through query themes, accumulating finds into a persistent
 * watchlist (fixtures/watchlist.json), and printing two leaderboards:
 *   🎓 migrated / token candidates   (pump.fun launches as they migrate)
 *   🐦 X accounts to track           (token optional — ranked on account quality)
 *
 *   npm run discover                      # single pass, default theme
 *   npm run discover -- --loop 6          # auto mode: 6 themed iterations
 *   npm run discover -- --theme depin     # target one theme
 *   npm run discover -- "custom x query"  # custom recent-search query
 *   npm run discover -- --hours 24        # migration window (default 24h)
 *
 * Requires X_API_BEARER_TOKEN + BITQUERY_API_KEY (+ BIRDEYE_API_KEY for mcap).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { XApiProvider } from "@/lib/providers/x";
import { BitqueryProvider } from "@/lib/providers/bitquery";
import { PriceProvider } from "@/lib/providers/price";
import { scanSignalSources, type SignalSource } from "@/lib/discovery/scan";
import {
  extractContractAddress,
  extractUrls,
  firstWebsiteUrl,
  handleFromXUrl,
} from "@/lib/extract";

const X_ENRICH_CAP = 24;
const MIG_ENRICH_CAP = 8;
const CROSS_CAP = 16;
const WATCHLIST = path.resolve("fixtures/watchlist.json");

/** Recent-search query themes — each iteration probes a different niche. */
const THEMES: Record<string, string> = {
  ai: '("decentralized AI" OR "AI agent" OR "AI inference" OR "AI model") (launched OR live OR "CA:" OR mainnet OR pumpfun) -is:retweet lang:en',
  launch: '(pumpfun OR "pump.fun" OR "fair launch" OR "stealth launch" OR graduated OR "just migrated") (AI OR agent OR protocol OR network) -is:retweet lang:en',
  depin: '(DePIN OR "decentralized compute" OR "gpu network" OR "decentralized network") (launch OR live OR token OR "CA:") -is:retweet lang:en',
  agents: '("ai agent" OR "autonomous agent" OR "agent swarm" OR "trading agent") (solana OR onchain OR token OR launched) -is:retweet lang:en',
  infra: "(mainnet OR testnet) (launch OR live) (L2 OR rollup OR appchain OR perps OR defi OR protocol) -is:retweet lang:en",
  rwa: '(RWA OR "real world assets" OR tokenized OR tokenization) (launch OR live OR protocol OR token) -is:retweet lang:en',
};
const THEME_ORDER = ["ai", "launch", "depin", "agents", "infra", "rwa"];

type Source = "x" | "migration";

interface Unified {
  handle: string | null;
  mint: string | null;
  symbol: string | null;
  migratedAt: string | null;
  holders: number | null;
  traders24h: number | null;
  marketCapUsd: number | null;
  followers: number | null;
  ageDays: number | null;
  website: string | null;
  foundBy: Set<Source>;
}

interface Entry {
  handle: string | null;
  mint: string | null;
  symbol: string | null;
  category: "migrated" | "token" | "track";
  migratedAt: string | null;
  holders: number | null;
  traders24h: number | null;
  marketCapUsd: number | null;
  followers: number | null;
  ageDays: number | null;
  website: string | null;
  sources: Source[];
  combined: number;
  track: number;
  firstSeen: string;
  lastSeen: string;
  seenCount: number;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

const ageDays = (iso: string | null) =>
  iso && !Number.isNaN(new Date(iso).getTime())
    ? Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000)
    : null;

/** Score for the on-chain "did it launch + get traction" angle. */
function combinedScore(u: Unified | Entry): number {
  let s = 0;
  if (u.migratedAt) s += 20;
  const h = u.holders ?? 0;
  if (h >= 2000) s += 20;
  else if (h >= 500) s += 14;
  else if (h >= 100) s += 8;
  else if (h >= 20) s += 3;
  const t = u.traders24h ?? 0;
  if (t >= 1000) s += 12;
  else if (t >= 200) s += 8;
  else if (t >= 50) s += 4;
  const f = u.followers ?? 0;
  if (f >= 1000) s += 12;
  else if (f >= 200) s += 7;
  else if (f >= 50) s += 3;
  if (u.ageDays != null && u.ageDays <= 90) s += 8;
  if (u.website) s += 5;
  const sourceCount = "foundBy" in u ? u.foundBy.size : u.sources.length;
  if (sourceCount > 1) s += 20;
  else if ((u.holders != null || u.migratedAt) && u.followers != null) s += 12;
  return s;
}

/** Score for "X account worth tracking" — token optional, prefers fresh + credible. */
function trackScore(u: Unified | Entry): number {
  let s = 0;
  const f = u.followers ?? 0;
  if (f >= 500 && f <= 100_000) s += 25;
  else if (f >= 200) s += 15;
  else if (f >= 50) s += 5;
  if (u.ageDays != null) {
    if (u.ageDays <= 60) s += 25;
    else if (u.ageDays <= 180) s += 15;
    else if (u.ageDays <= 365) s += 5;
    else s -= 5; // established accounts are rarely the early gem
  }
  if (u.website) s += 10;
  if (u.mint || u.holders != null) s += 10; // has a token (bonus, not required)
  if ((u.holders ?? 0) >= 500) s += 10;
  return s;
}

const divergent = (u: { holders: number | null; followers: number | null }) =>
  (u.holders ?? 0) >= 500 && (u.followers ?? 1e9) < 200;

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const usd = (n: number | null) =>
  n == null ? "?" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`;
const num = (n: number | null) => (n == null ? "?" : n.toLocaleString());
const keyOf = (u: { handle: string | null; mint: string | null }) =>
  (u.handle ? u.handle.toLowerCase() : u.mint) ?? "";

function loadWatchlist(): Record<string, Entry> {
  try {
    return JSON.parse(readFileSync(WATCHLIST, "utf8")) as Record<string, Entry>;
  } catch {
    return {};
  }
}

async function main() {
  if (!process.env.X_API_BEARER_TOKEN || !process.env.BITQUERY_API_KEY) {
    console.error("Set X_API_BEARER_TOKEN and BITQUERY_API_KEY.");
    process.exit(1);
  }
  process.env.SUPABASE_URL ??= "https://mock.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "mock";

  const args = process.argv.slice(2);
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const loops = Math.max(1, Number(flag("--loop") ?? 1) || 1);
  const themeArg = flag("--theme");
  const hours = Number(flag("--hours") ?? 24) || 24;
  const custom = args.find((a) => !a.startsWith("--") && a !== flag("--loop") && a !== flag("--hours") && a !== themeArg);
  const sinceISO = new Date(Date.now() - hours * 3_600_000).toISOString();

  const x = new XApiProvider();
  const bq = new BitqueryProvider();
  const price = new PriceProvider();

  const all: Unified[] = [];
  const byHandle = new Map<string, Unified>();
  const byMint = new Map<string, Unified>();
  const enrichedHandles = new Set<string>();
  const seenMints = new Set<string>();

  function upsert(p: Omit<Partial<Unified>, "foundBy"> & { foundBy: Source }): void {
    const hk = p.handle ? p.handle.toLowerCase() : null;
    let u = (hk && byHandle.get(hk)) || (p.mint && byMint.get(p.mint)) || null;
    if (!u) {
      u = { handle: null, mint: null, symbol: null, migratedAt: null, holders: null, traders24h: null, marketCapUsd: null, followers: null, ageDays: null, website: null, foundBy: new Set() };
      all.push(u);
    }
    u.handle ??= p.handle ?? null;
    u.mint ??= p.mint ?? null;
    u.symbol ??= p.symbol ?? null;
    u.migratedAt ??= p.migratedAt ?? null;
    if (p.holders != null) u.holders = Math.max(u.holders ?? 0, p.holders);
    if (p.traders24h != null) u.traders24h = Math.max(u.traders24h ?? 0, p.traders24h);
    if (p.marketCapUsd != null) u.marketCapUsd = Math.max(u.marketCapUsd ?? 0, p.marketCapUsd);
    if (p.followers != null) u.followers = p.followers;
    if (p.ageDays != null) u.ageDays = p.ageDays;
    u.website ??= p.website ?? null;
    u.foundBy.add(p.foundBy);
    if (u.handle) byHandle.set(u.handle.toLowerCase(), u);
    if (u.mint) byMint.set(u.mint, u);
  }

  const startCount = () => all.length;

  // Fetch migrations ONCE (same window every iteration); enrich a fresh batch
  // per iteration so coverage spreads across the loop and Bitquery isn't bursted.
  const { migrations, total: migTotal } = await bq
    .recentMigrations(sinceISO, 150)
    .catch(() => ({ migrations: [] as { mint: string; migratedAt: string }[], total: 0 }));

  for (let i = 0; i < loops; i++) {
    const theme = themeArg ?? THEME_ORDER[i % THEME_ORDER.length];
    const query = custom ?? THEMES[theme] ?? THEMES.ai;
    const sources: SignalSource[] = [{ id: `${theme}-${i}`, kind: "query", value: query }];
    const before = startCount();

    // X vector.
    const xHits = await scanSignalSources(x, sources, { perSource: 25 });
    const newX = xHits.filter((c) => !enrichedHandles.has(c.handle.toLowerCase())).slice(0, X_ENRICH_CAP);
    await mapLimit(newX, 5, async (c) => {
      enrichedHandles.add(c.handle.toLowerCase());
      const u = await x.getUserById(c.xUserId).catch(() => null);
      if (!u) return;
      upsert({
        handle: u.username,
        mint: extractContractAddress(u.description),
        followers: u.followersCount,
        ageDays: ageDays(u.createdAt),
        website: firstWebsiteUrl([...u.urls, ...extractUrls(u.description ?? "")]),
        foundBy: "x",
      });
    });

    // X→chain cross-fill (the join), before migration enrichment spends budget.
    const needOC = all
      .filter((u) => u.mint && u.holders == null)
      .sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0))
      .slice(0, CROSS_CAP);
    await mapLimit(needOC, 3, async (u) => {
      const oc = await bq.tokenOnchain(u.mint!).catch(() => null);
      if (!oc) return;
      u.holders = oc.holderCount;
      u.traders24h = oc.traders24h;
      u.symbol ??= oc.symbol;
    });

    // Migration vector — a fresh batch of not-yet-seen mints this iteration.
    const newMints = migrations.filter((m) => !seenMints.has(m.mint)).slice(0, MIG_ENRICH_CAP);
    await mapLimit(newMints, 3, async (m) => {
      seenMints.add(m.mint);
      const [meta, oc, ov] = await Promise.all([
        bq.tokenMetadata(m.mint).catch(() => null),
        bq.tokenOnchain(m.mint).catch(() => null),
        price.tokenOverview(m.mint).catch(() => null),
      ]);
      upsert({
        handle: handleFromXUrl(meta?.twitter),
        mint: m.mint,
        symbol: meta?.symbol ?? oc?.symbol ?? ov?.symbol ?? null,
        migratedAt: m.migratedAt,
        holders: oc?.holderCount ?? null,
        traders24h: oc?.traders24h ?? null,
        marketCapUsd: ov?.marketCapUsd ?? null,
        website: meta?.website ?? ov?.website ?? null,
        foundBy: "migration",
      });
    });

    // Migration handle → X profile cross-fill.
    const needX = all.filter((u) => u.handle && u.followers == null && !enrichedHandles.has(u.handle.toLowerCase())).slice(0, CROSS_CAP);
    await mapLimit(needX, 5, async (u) => {
      enrichedHandles.add(u.handle!.toLowerCase());
      const x2 = await x.getUserByHandle(u.handle!).catch(() => null);
      if (!x2) return;
      u.followers = x2.followersCount;
      u.ageDays = ageDays(x2.createdAt);
      u.mint ??= extractContractAddress(x2.description);
      u.website ??= firstWebsiteUrl([...x2.urls, ...extractUrls(x2.description ?? "")]);
    });

    console.log(
      `iter ${i + 1}/${loops} [${theme}] — ${migTotal} migrations in window (enriched +${newMints.length}) · +${all.length - before} new candidates (total ${all.length})`,
    );
  }

  // Categorize + merge into the persistent watchlist.
  const now = new Date().toISOString();
  const wl = loadWatchlist();
  let added = 0;
  for (const u of all) {
    const key = keyOf(u);
    if (!key) continue;
    const category = u.migratedAt ? "migrated" : u.mint || u.holders != null ? "token" : "track";
    const prev = wl[key];
    if (!prev) added++;
    const merged: Entry = {
      handle: u.handle ?? prev?.handle ?? null,
      mint: u.mint ?? prev?.mint ?? null,
      symbol: u.symbol ?? prev?.symbol ?? null,
      category,
      migratedAt: u.migratedAt ?? prev?.migratedAt ?? null,
      holders: Math.max(u.holders ?? 0, prev?.holders ?? 0) || null,
      traders24h: Math.max(u.traders24h ?? 0, prev?.traders24h ?? 0) || null,
      marketCapUsd: Math.max(u.marketCapUsd ?? 0, prev?.marketCapUsd ?? 0) || null,
      followers: u.followers ?? prev?.followers ?? null,
      ageDays: u.ageDays ?? prev?.ageDays ?? null,
      website: u.website ?? prev?.website ?? null,
      sources: [...new Set([...(prev?.sources ?? []), ...u.foundBy])],
      combined: 0,
      track: 0,
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
      seenCount: (prev?.seenCount ?? 0) + 1,
    };
    merged.combined = combinedScore(merged);
    merged.track = trackScore(merged);
    wl[key] = merged;
  }
  mkdirSync(path.dirname(WATCHLIST), { recursive: true });
  writeFileSync(WATCHLIST, JSON.stringify(wl, null, 2));

  const entries = Object.values(wl);

  const marker = (s: Source[]) => (s.length > 1 ? "🔗" : s.includes("migration") ? "⛓ " : "🐦");

  // 🎓 Migrated / token leaderboard (measured on-chain traction only).
  console.log(`\n🎓 MIGRATED / TOKEN candidates (top by traction)`);
  console.log(`  ${pad("src", 4)}${pad("handle/mint", 20)}${pad("sym", 9)}${pad("mcap", 7)}${pad("holders", 9)}${pad("trd24h", 8)}${pad("follow", 8)}${pad("score", 6)}`);
  console.log(`  ${"-".repeat(78)}`);
  entries
    .filter((e) => e.category !== "track" && e.holders != null)
    .sort((a, b) => b.combined - a.combined)
    .slice(0, 12)
    .forEach((e) => {
      console.log(
        `  ${pad(marker(e.sources), 4)}${pad(e.handle ? "@" + e.handle : (e.mint ?? "").slice(0, 10) + "…", 20)}${pad(e.symbol ?? "?", 9)}${pad(usd(e.marketCapUsd), 7)}${pad(num(e.holders), 9)}${pad(num(e.traders24h), 8)}${pad(num(e.followers), 8)}${pad(e.combined, 6)}${divergent(e) ? " ⚠" : ""}`,
      );
    });

  // 🐦 Accounts to track leaderboard.
  console.log(`\n🐦 X ACCOUNTS TO TRACK (top by account quality — token optional)`);
  console.log(`  ${pad("handle", 20)}${pad("followers", 11)}${pad("age(d)", 8)}${pad("token", 7)}${pad("site", 6)}${pad("score", 6)}`);
  console.log(`  ${"-".repeat(70)}`);
  entries
    .filter((e) => e.handle)
    .sort((a, b) => b.track - a.track)
    .slice(0, 12)
    .forEach((e) => {
      console.log(
        `  ${pad("@" + e.handle, 20)}${pad(num(e.followers), 11)}${pad(e.ageDays ?? "?", 8)}${pad(e.mint || e.holders != null ? "yes" : "-", 7)}${pad(e.website ? "yes" : "-", 6)}${pad(e.track, 6)}`,
      );
    });

  const migrated = entries.filter((e) => e.category === "migrated").length;
  const tracked = entries.filter((e) => e.category === "track").length;
  console.log(
    `\n📋 watchlist: ${entries.length} total (${migrated} migrated · ${tracked} track-only) · +${added} new this run · ${path.relative(process.cwd(), WATCHLIST)}`,
  );
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
