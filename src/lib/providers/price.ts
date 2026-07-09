export interface PriceData {
  token: string | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  priceUsd: number | null;
  source: string;
  notes: string;
}

/** Richer Birdeye token_overview (includes socials, for migration discovery). */
export interface TokenOverview {
  symbol: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  twitter: string | null;
  website: string | null;
}

const EMPTY: PriceData = {
  token: null,
  marketCapUsd: null,
  volume24hUsd: null,
  priceUsd: null,
  source: "none",
  notes: "No token / price data found.",
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Resolves token market data by **on-chain contract address** — the right level
 * for super-early discovery. CoinGecko is intentionally NOT used: by the time a
 * token is listed there the early window is gone. Primary source is Birdeye
 * (Solana, by mint); DexScreener-by-address is a free fallback. Returns a
 * neutral empty result if there is no token / no market yet.
 */
export class PriceProvider {
  private readonly birdeyeKey?: string;

  constructor(birdeyeKey = process.env.BIRDEYE_API_KEY) {
    this.birdeyeKey = birdeyeKey;
  }

  /** Look up market data for a Solana token mint / contract address. */
  async lookupByMint(mint: string): Promise<PriceData> {
    const be = await this.tryBirdeye(mint).catch(() => null);
    if (be) return be;
    const dx = await this.tryDexScreener(mint).catch(() => null);
    if (dx) return dx;
    return { ...EMPTY };
  }

  /** Full Birdeye token_overview (price, market data, socials). */
  async tokenOverview(mint: string): Promise<TokenOverview | null> {
    if (!this.birdeyeKey) return null;
    const res = await fetch(
      `https://public-api.birdeye.so/defi/token_overview?address=${encodeURIComponent(mint)}`,
      { headers: { "X-API-KEY": this.birdeyeKey, "x-chain": "solana" } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      success?: boolean;
      data?: {
        symbol?: string;
        price?: number;
        marketCap?: number;
        mc?: number;
        v24hUSD?: number;
        liquidity?: number;
        extensions?: { twitter?: string; website?: string };
      };
    };
    const d = body.data;
    if (!body.success || !d) return null;
    return {
      symbol: d.symbol ?? null,
      priceUsd: d.price ?? null,
      marketCapUsd: d.marketCap ?? d.mc ?? null,
      volume24hUsd: d.v24hUSD ?? null,
      liquidityUsd: d.liquidity ?? null,
      twitter: d.extensions?.twitter ?? null,
      website: d.extensions?.website ?? null,
    };
  }

  private async tryBirdeye(mint: string): Promise<PriceData | null> {
    const o = await this.tokenOverview(mint);
    if (!o || (o.priceUsd == null && o.marketCapUsd == null)) return null;
    return {
      token: o.symbol,
      marketCapUsd: o.marketCapUsd,
      volume24hUsd: o.volume24hUsd,
      priceUsd: o.priceUsd,
      source: "birdeye",
      notes: `Birdeye token_overview for ${short(mint)}.`,
    };
  }

  private async tryDexScreener(address: string): Promise<PriceData | null> {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      pairs?: {
        baseToken?: { symbol?: string };
        priceUsd?: string;
        fdv?: number;
        marketCap?: number;
        volume?: { h24?: number };
      }[];
    };
    // Most-liquid pair first.
    const pair = (data.pairs ?? []).sort(
      (a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0),
    )[0];
    if (!pair) return null;
    return {
      token: pair.baseToken?.symbol?.toUpperCase() ?? null,
      marketCapUsd: pair.marketCap ?? pair.fdv ?? null,
      volume24hUsd: pair.volume?.h24 ?? null,
      priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
      source: "dexscreener",
      notes: `DexScreener token lookup by address ${short(address)}.`,
    };
  }

  /**
   * Birdeye OHLCV for a mint — used for outcome backfill (price at T+Nh).
   * `type`: 1m | 5m | 15m | 1h | 4h | 1d
   * time_from / time_to: unix seconds.
   */
  async ohlcv(
    mint: string,
    opts: { type?: string; time_from: number; time_to: number },
  ): Promise<Array<{ unixTime: number; o: number; h: number; l: number; c: number; v: number }>> {
    if (!this.birdeyeKey) return [];
    const type = opts.type ?? "1h";
    const url = new URL("https://public-api.birdeye.so/defi/ohlcv");
    url.searchParams.set("address", mint);
    url.searchParams.set("type", type);
    url.searchParams.set("time_from", String(opts.time_from));
    url.searchParams.set("time_to", String(opts.time_to));
    const res = await fetch(url.toString(), {
      headers: { "X-API-KEY": this.birdeyeKey, "x-chain": "solana", accept: "application/json" },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      success?: boolean;
      data?: { items?: Array<{ unixTime?: number; o?: number; h?: number; l?: number; c?: number; v?: number }> };
    };
    if (!body.success || !body.data?.items) return [];
    return body.data.items
      .filter((i) => i.unixTime != null && i.c != null)
      .map((i) => ({
        unixTime: i.unixTime as number,
        o: i.o ?? i.c!,
        h: i.h ?? i.c!,
        l: i.l ?? i.c!,
        c: i.c as number,
        v: i.v ?? 0,
      }));
  }

  /**
   * Historical USD price near a unix timestamp (seconds).
   * Tries Birdeye historical_price_unix, then falls back to OHLCV close.
   */
  async priceAtUnix(mint: string, unixSec: number): Promise<{ priceUsd: number; source: string } | null> {
    if (!this.birdeyeKey) return null;

    try {
      const url = new URL("https://public-api.birdeye.so/defi/historical_price_unix");
      url.searchParams.set("address", mint);
      url.searchParams.set("unixtime", String(unixSec));
      const res = await fetch(url.toString(), {
        headers: { "X-API-KEY": this.birdeyeKey, "x-chain": "solana", accept: "application/json" },
      });
      if (res.ok) {
        const body = (await res.json()) as { success?: boolean; data?: { value?: number; price?: number } };
        const v = body.data?.value ?? body.data?.price;
        if (body.success && typeof v === "number" && v > 0) {
          return { priceUsd: v, source: "birdeye_unix" };
        }
      }
    } catch {
      /* fall through */
    }

    // ±2h window of 15m candles
    const candles = await this.ohlcv(mint, {
      type: "15m",
      time_from: unixSec - 2 * 3600,
      time_to: unixSec + 2 * 3600,
    });
    const c = candles.length
      ? candles.reduce((best, k) => {
          const d = Math.abs(k.unixTime - unixSec);
          if (!best || d < best.d) return { c: k.c, d };
          return best;
        }, null as { c: number; d: number } | null)?.c
      : null;
    if (c != null && c > 0) return { priceUsd: c, source: "birdeye_ohlcv" };
    return null;
  }
}
