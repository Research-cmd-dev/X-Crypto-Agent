/**
 * Unified discovery — combine the X search and the on-chain migration search by
 * joining on the X-handle ↔ contract-address link, so every candidate gets BOTH
 * an on-chain profile (migrated? holders / traders / mcap) and a social profile
 * (followers / age / website). Candidates confirmed on both sides rank highest;
 * the command also flags tokens whose on-chain traction wildly outruns their
 * social presence (a bot-traded / pump signal).
 *
 *   npm run discover                 # default X queries + today's migrations
 *   npm run discover -- "x query"    # custom X recent-search query
 *   npm run discover -- --hours 24   # widen the migration window
 *
 * Requires X_API_BEARER_TOKEN + BITQUERY_API_KEY (+ BIRDEYE_API_KEY for mcap).
 */
import { XApiProvider } from "@/lib/providers/x";
import { BitqueryProvider } from "@/lib/providers/bitquery";
import { PriceProvider } from "@/lib/providers/price";
import { scanSignalSources, DEFAULT_SOURCES, type SignalSource } from "@/lib/discovery/scan";
import {
  extractContractAddress,
  extractUrls,
  firstWebsiteUrl,
  handleFromXUrl,
} from "@/lib/extract";

const X_ENRICH_CAP = 30;
const MIG_ENRICH_CAP = 15;
const CROSS_CAP = 20;

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

function combinedScore(u: Unified): number {
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
  if (u.foundBy.size > 1) s += 20; // confirmed by BOTH search vectors
  else if ((u.holders != null || u.migratedAt) && u.followers != null) s += 12; // both dimensions present
  return s;
}

/** On-chain traction with almost no social presence = bot/pump signal. */
const divergent = (u: Unified) => (u.holders ?? 0) >= 500 && (u.followers ?? 1e9) < 200;

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const usd = (n: number | null) =>
  n == null ? "?" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`;
const num = (n: number | null) => (n == null ? "?" : n.toLocaleString());

async function main() {
  if (!process.env.X_API_BEARER_TOKEN || !process.env.BITQUERY_API_KEY) {
    console.error("Set X_API_BEARER_TOKEN and BITQUERY_API_KEY.");
    process.exit(1);
  }
  process.env.SUPABASE_URL ??= "https://mock.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "mock";

  const args = process.argv.slice(2);
  const hoursArg = args.includes("--hours") ? Number(args[args.indexOf("--hours") + 1]) : NaN;
  const custom = args.find((a) => !a.startsWith("--") && a !== String(hoursArg));
  const hours = Number.isFinite(hoursArg) && hoursArg > 0 ? hoursArg : 24; // rolling window
  const since = new Date(Date.now() - hours * 3_600_000);

  const x = new XApiProvider();
  const bq = new BitqueryProvider();
  const price = new PriceProvider();

  const all: Unified[] = [];
  const byHandle = new Map<string, Unified>();
  const byMint = new Map<string, Unified>();

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
    u.holders ??= p.holders ?? null;
    u.traders24h ??= p.traders24h ?? null;
    u.marketCapUsd ??= p.marketCapUsd ?? null;
    u.followers ??= p.followers ?? null;
    u.ageDays ??= p.ageDays ?? null;
    u.website ??= p.website ?? null;
    u.foundBy.add(p.foundBy);
    if (u.handle) byHandle.set(u.handle.toLowerCase(), u);
    if (u.mint) byMint.set(u.mint, u);
  }

  // 1. X search vector.
  const sources: SignalSource[] = custom ? [{ id: "custom", kind: "query", value: custom }] : DEFAULT_SOURCES;
  console.log(`\n🛰  X search across ${sources.length} source(s) + 🎓 migrations since ${since.toISOString()} …`);
  const xHits = await scanSignalSources(x, sources, { perSource: 25 });
  await mapLimit(xHits.slice(0, X_ENRICH_CAP), 5, async (c) => {
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

  // 2. X→chain cross-fill FIRST (the core of the combination), before migration
  // enrichment spends the on-chain API budget. Prioritise the credible accounts.
  const needOC = all
    .filter((u) => u.mint && u.holders == null)
    .sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0))
    .slice(0, CROSS_CAP);
  await mapLimit(needOC, 5, async (u) => {
    const oc = await bq.tokenOnchain(u.mint!).catch(() => null);
    if (!oc) return;
    u.holders = oc.holderCount;
    u.traders24h = oc.traders24h;
    u.symbol ??= oc.symbol;
  });

  // 3. On-chain migration vector.
  const { migrations, total } = await bq.recentMigrations(since.toISOString(), 60);
  await mapLimit(migrations.slice(0, MIG_ENRICH_CAP), 5, async (m) => {
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

  // 4. Cross-fill migration handles → X profile (followers/age).
  const needX = all.filter((u) => u.handle && u.followers == null).slice(0, CROSS_CAP);
  await mapLimit(needX, 5, async (u) => {
    const x2 = await x.getUserByHandle(u.handle!).catch(() => null);
    if (!x2) return;
    u.followers = x2.followersCount;
    u.ageDays = ageDays(x2.createdAt);
    u.mint ??= extractContractAddress(x2.description);
    u.website ??= firstWebsiteUrl([...x2.urls, ...extractUrls(x2.description ?? "")]);
  });

  // 4. Score + present (drop candidates with no actionable signal).
  const ranked = all
    .filter((u) => u.handle || u.holders != null || u.followers != null)
    .map((u) => ({ u, score: combinedScore(u) }))
    .sort((a, b) => b.score - a.score);

  console.log(`\n${total} migrations in window · ${xHits.length} X hits · ${ranked.length} actionable candidates\n`);
  console.log(
    `  ${pad("src", 5)}${pad("handle", 18)}${pad("sym", 9)}${pad("mcap", 7)}${pad("holders", 9)}${pad("trd24h", 8)}${pad("follow", 8)}${pad("age", 6)}${pad("score", 7)}`,
  );
  console.log(`  ${"-".repeat(85)}`);
  for (const { u, score } of ranked.slice(0, 25)) {
    const mark = u.foundBy.size > 1 ? "🔗" : u.foundBy.has("migration") ? "⛓ " : "🐦";
    console.log(
      `  ${pad(mark, 5)}${pad(u.handle ? "@" + u.handle : (u.mint ?? "").slice(0, 8) + "…", 18)}${pad(u.symbol ?? "?", 9)}${pad(usd(u.marketCapUsd), 7)}${pad(num(u.holders), 9)}${pad(num(u.traders24h), 8)}${pad(num(u.followers), 8)}${pad(u.ageDays ?? "?", 6)}${pad(score, 7)}${divergent(u) ? " ⚠ traction≫social" : ""}`,
    );
  }

  // Highest-conviction = strong on both dimensions, not divergent.
  const best = ranked.find(
    ({ u }) => u.handle && (u.holders ?? 0) >= 100 && (u.followers ?? 0) >= 200 && !divergent(u),
  );
  console.log(`\nLegend: 🔗 confirmed by both searches · ⛓ migration-only · 🐦 X-only · ⚠ on-chain traction with little social`);
  if (best) {
    console.log(`\nHighest-conviction (traction + real social): @${best.u.handle}`);
    console.log(`Run the full swarm:  npm run analyze -- ${best.u.handle}`);
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
