/**
 * Collect LaunchFeatures for a graduated mint from available providers.
 *
 * Primary (preferred, no LLM):
 *   - Solana Tracker: holders, symbol, twitter, list mcap/liq
 *   - Price (Birdeye / DexScreener): mcap, volume, liquidity, twitter
 *   - Bitquery (optional): traders24h, trades24h, holders fallback
 *
 * Optional enrichment (swap-friendly):
 *   - GMGN: risk, top10, renounce, smart money — only if GMGN_API_KEY set.
 *     Can be replaced later with another security/smart-money provider without
 *     changing computeLaunchScore.
 */
import { SolanaTrackerProvider } from "@/lib/providers/solanatracker";
import { PriceProvider } from "@/lib/providers/price";
import { BitqueryProvider } from "@/lib/providers/bitquery";
import { GmgnProvider } from "@/lib/providers/gmgn";
import { handleFromXUrl } from "@/lib/extract";
import type { LaunchFeatures } from "@/lib/schema/launch-score";

export interface SeedGraduation {
  mint: string;
  graduatedAt?: string | null;
  symbol?: string | null;
  twitter?: string | null;
  marketCapUsd?: number | null;
  liquidityUsd?: number | null;
  holders?: number | null;
  traders24h?: number | null;
  trades24h?: number | null;
}

export interface CollectOptions {
  /** Skip optional GMGN even if key present (faster / offline). */
  skipGmgn?: boolean;
  /** Skip Bitquery traders lookup. */
  skipBitquery?: boolean;
  st?: SolanaTrackerProvider | null;
  price?: PriceProvider | null;
  bitquery?: BitqueryProvider | null;
  gmgn?: GmgnProvider | null;
}

export async function collectLaunchFeatures(
  seed: SeedGraduation,
  opts: CollectOptions = {},
): Promise<LaunchFeatures> {
  const sources: string[] = [];
  const st =
    opts.st !== undefined
      ? opts.st
      : process.env.SOLANATRACKER_API_KEY
        ? new SolanaTrackerProvider()
        : null;
  const price = opts.price !== undefined ? opts.price : new PriceProvider();
  const bitquery =
    opts.bitquery !== undefined
      ? opts.bitquery
      : !opts.skipBitquery && process.env.BITQUERY_API_KEY
        ? new BitqueryProvider()
        : null;
  const gmgn =
    opts.gmgn !== undefined
      ? opts.gmgn
      : !opts.skipGmgn && process.env.GMGN_API_KEY
        ? new GmgnProvider()
        : null;

  let holders = seed.holders ?? null;
  let traders24h = seed.traders24h ?? null;
  let trades24h = seed.trades24h ?? null;
  let liquidityUsd = seed.liquidityUsd ?? null;
  let marketCapUsd = seed.marketCapUsd ?? null;
  let volume24hUsd: number | null = null;
  let twitter = seed.twitter ?? null;
  let mintRenounced: boolean | null = null;
  let freezeRenounced: boolean | null = null;
  let top10HolderPct: number | null = null;
  let riskScore: number | null = null;
  let smartMoneyCount: number | null = null;

  const tasks: Promise<void>[] = [];

  if (st) {
    tasks.push(
      (async () => {
        const [h, info] = await Promise.all([
          st.tokenHolders(seed.mint).catch(() => null),
          st.tokenInfo(seed.mint).catch(() => null),
        ]);
        if (h?.total != null) {
          holders = holders ?? h.total;
          sources.push("solanatracker");
        }
        if (info) {
          if (info.twitter && !twitter) twitter = info.twitter;
          // pools may carry liq; best-effort
          const pool0 = info.pools?.[0];
          const liq = pool0?.liquidity?.usd ?? pool0?.liquidityUsd;
          if (typeof liq === "number" && liquidityUsd == null) liquidityUsd = liq;
          if (!sources.includes("solanatracker")) sources.push("solanatracker");
        }
      })(),
    );
  }

  if (price) {
    tasks.push(
      (async () => {
        const ov = await price.tokenOverview(seed.mint).catch(() => null);
        if (ov) {
          sources.push("birdeye");
          marketCapUsd = marketCapUsd ?? ov.marketCapUsd;
          volume24hUsd = ov.volume24hUsd ?? null;
          liquidityUsd = liquidityUsd ?? ov.liquidityUsd;
          if (ov.twitter && !twitter) twitter = ov.twitter;
          return;
        }
        const p = await price.lookupByMint(seed.mint).catch(() => null);
        if (p && p.source !== "none") {
          sources.push(p.source);
          marketCapUsd = marketCapUsd ?? p.marketCapUsd;
          volume24hUsd = p.volume24hUsd ?? null;
        }
      })(),
    );
  }

  if (bitquery) {
    tasks.push(
      (async () => {
        const oc = await bitquery.tokenOnchain(seed.mint).catch(() => null);
        if (!oc) return;
        sources.push("bitquery");
        holders = holders ?? oc.holderCount ?? null;
        traders24h = traders24h ?? oc.traders24h ?? null;
        trades24h = trades24h ?? oc.trades24h ?? null;
      })(),
    );
  }

  if (gmgn) {
    tasks.push(
      (async () => {
        const g = await gmgn.tokenInfo(seed.mint).catch(() => null);
        if (!g) return;
        sources.push("gmgn");
        mintRenounced = g.mintRenounced;
        freezeRenounced = g.freezeRenounced;
        top10HolderPct = g.top10HolderPct;
        riskScore = g.riskScore ?? null;
        smartMoneyCount = g.smartMoneyCount ?? null;
        holders = holders ?? g.holderCount ?? null;
      })(),
    );
  }

  await Promise.all(tasks);

  let twHandle: string | null = null;
  if (twitter) {
    twHandle = handleFromXUrl(twitter);
    if (!twHandle) {
      const stripped = twitter.replace(/^@/, "").replace(/.*\//, "");
      twHandle = stripped || null;
    }
  }

  return {
    mint: seed.mint,
    holders,
    traders24h,
    trades24h,
    liquidityUsd,
    marketCapUsd,
    volume24hUsd,
    mintRenounced,
    freezeRenounced,
    top10HolderPct,
    riskScore,
    smartMoneyCount,
    hasTwitter: Boolean(twHandle),
    followers: null, // optional X enrich later for top-K only
    graduatedAt: seed.graduatedAt ?? null,
    sources: [...new Set(sources)],
  };
}

/** Concurrency-limited map for batch feature collection. */
export async function collectLaunchFeaturesBatch(
  seeds: SeedGraduation[],
  concurrency = 5,
  opts: CollectOptions = {},
): Promise<LaunchFeatures[]> {
  const out: LaunchFeatures[] = new Array(seeds.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, seeds.length) }, async () => {
      while (i < seeds.length) {
        const idx = i++;
        out[idx] = await collectLaunchFeatures(seeds[idx], opts);
      }
    }),
  );
  return out;
}
