/**
 * Collect LaunchFeatures for a graduated mint from available providers.
 *
 * Primary (no LLM):
 *   - Solana Tracker: holders, top10, risk, renounce-ish authorities, mcap/liq/vol, twitter
 *   - Price (Birdeye / DexScreener): mcap, volume, liquidity, twitter
 *   - Bitquery (optional): traders24h, trades24h
 *
 * Optional:
 *   - GMGN: risk/smart-money if key set (can be omitted; ST covers most safety fields now)
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
  riskScore?: number | null;
  top10HolderPct?: number | null;
  volume24hUsd?: number | null;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
}

export interface CollectOptions {
  skipGmgn?: boolean;
  skipBitquery?: boolean;
  st?: SolanaTrackerProvider | null;
  price?: PriceProvider | null;
  bitquery?: BitqueryProvider | null;
  gmgn?: GmgnProvider | null;
}

function renounced(auth: string | null | undefined): boolean | null {
  if (auth === undefined) return null;
  if (auth == null || auth === "" || auth === "null") return true;
  return false;
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
  let volume24hUsd = seed.volume24hUsd ?? null;
  let twitter = seed.twitter ?? null;
  let mintRenounced = renounced(seed.mintAuthority);
  let freezeRenounced = renounced(seed.freezeAuthority);
  let top10HolderPct = seed.top10HolderPct ?? null;
  let riskScore = seed.riskScore ?? null;
  let smartMoneyCount: number | null = null;

  if (seed.holders != null || seed.riskScore != null || seed.top10HolderPct != null) {
    sources.push("seed");
  }

  const tasks: Promise<void>[] = [];

  if (st) {
    tasks.push(
      (async () => {
        const [h, info] = await Promise.all([
          st.tokenHolders(seed.mint).catch(() => null),
          st.tokenInfo(seed.mint).catch(() => null),
        ]);
        let used = false;
        if (h?.total != null) {
          holders = holders ?? h.total;
          used = true;
        }
        if (h?.top10Pct != null && top10HolderPct == null) {
          top10HolderPct = h.top10Pct;
          used = true;
        }
        if (info) {
          used = true;
          if (info.twitter && !twitter) twitter = info.twitter;
          holders = holders ?? info.holders ?? null;
          marketCapUsd = marketCapUsd ?? info.marketCapUsd ?? null;
          liquidityUsd = liquidityUsd ?? info.liquidityUsd ?? null;
          volume24hUsd = volume24hUsd ?? info.volume24hUsd ?? null;
          riskScore = riskScore ?? info.riskScore ?? null;
          top10HolderPct = top10HolderPct ?? info.top10HolderPct ?? null;
          if (info.mintRenounced != null) mintRenounced = info.mintRenounced;
          if (info.freezeRenounced != null) freezeRenounced = info.freezeRenounced;
          const pool0 = info.pools?.[0];
          const liq = pool0?.liquidity?.usd ?? pool0?.liquidityUsd;
          if (typeof liq === "number" && liquidityUsd == null) liquidityUsd = liq;
        }
        if (used) sources.push("solanatracker");
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
          volume24hUsd = volume24hUsd ?? ov.volume24hUsd ?? null;
          liquidityUsd = liquidityUsd ?? ov.liquidityUsd;
          if (ov.twitter && !twitter) twitter = ov.twitter;
          return;
        }
        const p = await price.lookupByMint(seed.mint).catch(() => null);
        if (p && p.source !== "none") {
          sources.push(p.source);
          marketCapUsd = marketCapUsd ?? p.marketCapUsd;
          volume24hUsd = volume24hUsd ?? p.volume24hUsd ?? null;
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
        if (g.mintRenounced != null) mintRenounced = g.mintRenounced;
        if (g.freezeRenounced != null) freezeRenounced = g.freezeRenounced;
        top10HolderPct = top10HolderPct ?? g.top10HolderPct;
        riskScore = riskScore ?? g.riskScore ?? null;
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
    followers: null,
    graduatedAt: seed.graduatedAt ?? null,
    sources: [...new Set(sources)],
  };
}

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
