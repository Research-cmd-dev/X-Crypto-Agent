/**
 * Today's pump.fun migrations (graduations) — tokens that completed the bonding
 * curve and migrated to the AMM, a strong early signal (real buy pressure pushed
 * them past the cap). Prefers Solana Tracker; falls back to Bitquery. Enriches
 * with holders + market data + Twitter, ranks by market cap. No Supabase.
 *
 *   npm run migrations            # today (UTC)
 *   npm run migrations -- 48      # last 48 hours
 *
 * Requires SOLANATRACKER_API_KEY (preferred) or BITQUERY_API_KEY.
 * Optional: BIRDEYE_API_KEY for market data. Pipe a hit with a Twitter into the
 * full swarm:  npm run analyze -- <handle>
 */
import { BitqueryProvider } from "@/lib/providers/bitquery";
import { SolanaTrackerProvider } from "@/lib/providers/solanatracker";
import { PriceProvider } from "@/lib/providers/price";
import { handleFromXUrl } from "@/lib/extract";

const ENRICH_CAP = 18;

interface Row {
  mint: string;
  migratedAt: string;
  symbol: string | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  holders: number | null;
  traders24h: number | null;
  twitter: string | null;
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

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const usd = (n: number | null) =>
  n == null ? "?" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`;
const hhmm = (iso: string) => (iso ? iso.slice(11, 16) : "??:??");

async function main() {
  const useTracker = !!process.env.SOLANATRACKER_API_KEY;
  if (!useTracker && !process.env.BITQUERY_API_KEY) {
    console.error("Set SOLANATRACKER_API_KEY (preferred) or BITQUERY_API_KEY for migrations.");
    process.exit(1);
  }
  const hours = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? "");
  const since = new Date();
  if (Number.isFinite(hours) && hours > 0) since.setTime(Date.now() - hours * 3_600_000);
  else since.setUTCHours(0, 0, 0, 0); // start of today UTC
  const sinceISO = since.toISOString();

  const price = new PriceProvider();
  let rowsData: any[] = [];
  let total = 0;

  console.log(`\n🎓 pump.fun migrations since ${sinceISO} … (using ${useTracker ? "Solana Tracker" : "Bitquery"})`);
  if (useTracker) {
    const st = new SolanaTrackerProvider();
    const { graduations, total: t } = await st.recentGraduations(sinceISO, 60);
    total = t || graduations.length;
    rowsData = graduations.map((g: any) => ({
      mint: g.mint,
      migratedAt: g.graduatedAt || sinceISO,
      symbol: g.symbol,
      marketCapUsd: g.marketCapUsd,
      liquidityUsd: g.liquidityUsd,
      twitter: g.twitter,
    }));
  } else {
    const bq = new BitqueryProvider();
    const { migrations, total: t } = await bq.recentMigrations(sinceISO, 60);
    total = t;
    if (migrations.length === 0) {
      console.log("No migrations found in the window (or the migrate query returned nothing).");
      return;
    }
    // enrich with tracker? for now use bitquery style, but since no key assume empty
    rowsData = migrations;
  }
  if (rowsData.length === 0) {
    console.log("No migrations found in the window.");
    return;
  }
  console.log(`${total} token(s) migrated. Enriching the ${Math.min(ENRICH_CAP, rowsData.length)} most recent…\n`);

  const rows: Row[] = await mapLimit(rowsData.slice(0, ENRICH_CAP), 5, async (m: any) => {
    let meta: any = null, oc: any = null, ov: any = null;
    if (useTracker) {
      const st = new SolanaTrackerProvider();
      const info = await st.tokenInfo(m.mint).catch(() => null);
      if (info) {
        meta = { symbol: info.symbol, twitter: info.twitter ? "https://x.com/" + info.twitter : null };
      }
      const h = await st.tokenHolders(m.mint).catch(() => null);
      if (h) oc = { holderCount: h.total };
    } else {
      const bq = new BitqueryProvider();
      [meta, oc, ov] = await Promise.all([
        bq.tokenMetadata(m.mint).catch(() => null),
        bq.tokenOnchain(m.mint).catch(() => null),
        price.tokenOverview(m.mint).catch(() => null),
      ]);
    }
    const ov2 = useTracker ? null : ov; // for non tracker
    return {
      mint: m.mint,
      migratedAt: m.migratedAt,
      symbol: meta?.symbol ?? (m.symbol) ?? ov2?.symbol ?? null,
      marketCapUsd: m.marketCapUsd ?? ov2?.marketCapUsd ?? null,
      volume24hUsd: ov2?.volume24hUsd ?? null,
      holders: oc?.holderCount ?? m.holders ?? null,
      traders24h: null, // can extend
      twitter: handleFromXUrl(meta?.twitter ?? m.twitter),
    };
  });

  rows.sort((a, b) => (b.marketCapUsd ?? -1) - (a.marketCapUsd ?? -1));

  console.log(
    `  ${pad("time", 6)}${pad("symbol", 10)}${pad("mcap", 8)}${pad("vol24h", 9)}${pad("holders", 9)}${pad("trd24h", 8)}${pad("twitter", 18)}mint`,
  );
  console.log(`  ${"-".repeat(92)}`);
  for (const r of rows) {
    console.log(
      `  ${pad(hhmm(r.migratedAt), 6)}${pad(r.symbol ?? "?", 10)}${pad(usd(r.marketCapUsd), 8)}${pad(usd(r.volume24hUsd), 9)}${pad(r.holders?.toLocaleString() ?? "?", 9)}${pad(r.traders24h?.toLocaleString() ?? "?", 8)}${pad(r.twitter ? "@" + r.twitter : "-", 18)}${r.mint.slice(0, 6)}…${r.mint.slice(-4)}`,
    );
  }

  const analyzable = rows.filter((r) => r.twitter);
  console.log(`\n${analyzable.length} of the enriched migrations expose a Twitter (analyzable).`);
  if (analyzable.length) {
    console.log(`Run the full swarm on the biggest:  npm run analyze -- ${analyzable[0].twitter}`);
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
