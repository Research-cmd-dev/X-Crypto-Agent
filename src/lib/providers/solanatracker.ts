/**
 * Solana Tracker Data API provider — primary for pump.fun graduations + holders.
 * Base: https://data.solanatracker.io
 * Auth: x-api-key header.
 *
 * Real-time: scripts/watch-migrations.ts (Datastream WS).
 */

export interface GraduatedToken {
  mint: string;
  graduatedAt?: string;
  symbol: string | null;
  twitter: string | null;
  marketCapUsd?: number;
  liquidityUsd?: number;
  /** When present on list payload */
  holders?: number;
  riskScore?: number | null;
  top10HolderPct?: number | null;
  volume24hUsd?: number | null;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
}

export interface TokenHolders {
  total: number;
  top: Array<{ wallet: string; amount: number; percentage: number }>;
  /** Sum of top-10 holder % when accounts returned */
  top10Pct: number | null;
}

export interface SolanaTokenInfo {
  name: string | null;
  symbol: string | null;
  mint: string;
  twitter: string | null;
  website: string | null;
  image?: string;
  createdTime?: number;
  pools?: any[];
  holders?: number | null;
  marketCapUsd?: number | null;
  liquidityUsd?: number | null;
  volume24hUsd?: number | null;
  riskScore?: number | null;
  top10HolderPct?: number | null;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  mintRenounced?: boolean | null;
  freezeRenounced?: boolean | null;
}

const BASE = "https://data.solanatracker.io";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

export class SolanaTrackerProvider {
  private readonly apiKey?: string;

  constructor(apiKey = process.env.SOLANATRACKER_API_KEY) {
    this.apiKey = apiKey;
  }

  private async fetchJson(path: string, params: Record<string, any> = {}) {
    if (!this.apiKey) return null;
    const url = new URL(path, BASE);
    Object.entries(params).forEach(([k, v]) => {
      if (v != null) url.searchParams.set(k, String(v));
    });
    const res = await fetch(url.toString(), {
      headers: { "x-api-key": this.apiKey },
    });
    if (!res.ok) return null;
    return res.json();
  }

  /**
   * Recently graduated tokens (pump.fun migrations etc.).
   * Uses /tokens/multi/graduated.
   */
  async recentGraduations(
    sinceISO?: string,
    limit = 50,
  ): Promise<{ graduations: GraduatedToken[]; total?: number }> {
    if (!this.apiKey) return { graduations: [] };
    const params: any = { limit: Math.min(limit, 500) };
    if (sinceISO) {
      const ts = Math.floor(new Date(sinceISO).getTime() / 1000);
      params.minCreatedAt = ts;
    }
    const data = await this.fetchJson("/tokens/multi/graduated", params);
    if (!Array.isArray(data)) return { graduations: [] };

    const grads: GraduatedToken[] = data
      .map((item: any) => {
        const t = item.token || {};
        const p = (item.pools && item.pools[0]) || {};
        let tw = "";
        const ss = t.strictSocials || t.socials || {};
        if (typeof ss === "object") tw = ss.twitter || "";
        if (tw) tw = tw.replace(/.*\//, "").replace(/^@/, "");
        const mc = p.marketCap ? p.marketCap.usd || p.marketCap.quote : item.marketCapUsd;
        const liq = p.liquidity ? p.liquidity.usd : item.liquidityUsd;
        const graduatedMs =
          item.graduatedAt ??
          t.graduatedAt ??
          (t.creation?.created_time ? t.creation.created_time * 1000 : undefined);
        const graduatedAt =
          typeof graduatedMs === "number"
            ? new Date(graduatedMs > 1e12 ? graduatedMs : graduatedMs * 1000).toISOString()
            : t.creation?.created_time
              ? new Date(t.creation.created_time * 1000).toISOString()
              : undefined;

        return {
          mint: t.mint || item.mint,
          graduatedAt,
          symbol: t.symbol || item.symbol || null,
          twitter: tw || null,
          marketCapUsd: num(mc) ?? undefined,
          liquidityUsd: num(liq) ?? undefined,
          holders: num(item.holders ?? t.holders) ?? undefined,
          riskScore: num(item.riskScore ?? item.risk?.score ?? p.riskScore),
          top10HolderPct: num(item.top10 ?? item.top10HolderPct ?? p.top10),
          volume24hUsd: num(item.volume_24h ?? item.volume24h ?? item.volume),
          mintAuthority: str(item.mintAuthority ?? p.mintAuthority),
          freezeAuthority: str(item.freezeAuthority ?? p.freezeAuthority),
        };
      })
      .filter((g: GraduatedToken) => g.mint);

    return { graduations: grads.slice(0, limit), total: data.length };
  }

  async tokenInfo(mint: string): Promise<SolanaTokenInfo | null> {
    if (!this.apiKey) return null;
    const data = await this.fetchJson(`/tokens/${mint}`);
    if (!data || !data.token) return null;
    const t = data.token;
    let tw = "",
      ws = "";
    const ss = t.strictSocials || t.socials || {};
    if (typeof ss === "object") {
      tw = ss.twitter || "";
      ws = ss.website || "";
    }
    if (tw) tw = tw.replace(/.*\//, "").replace(/^@/, "");

    const p = (data.pools && data.pools[0]) || {};
    const mc = p.marketCap?.usd ?? p.marketCap?.quote ?? data.marketCapUsd;
    const liq = p.liquidity?.usd ?? data.liquidityUsd;
    const mintAuth = str(p.mintAuthority ?? data.mintAuthority ?? t.mintAuthority);
    const freezeAuth = str(p.freezeAuthority ?? data.freezeAuthority ?? t.freezeAuthority);

    return {
      name: t.name || null,
      symbol: t.symbol || null,
      mint: t.mint,
      twitter: tw || null,
      website: ws || null,
      image: t.image,
      createdTime: t.creation && t.creation.created_time,
      pools: data.pools || [],
      holders: num(data.holders ?? t.holders),
      marketCapUsd: num(mc),
      liquidityUsd: num(liq),
      volume24hUsd: num(data.volume_24h ?? data.volume24h ?? p.volume_24h),
      riskScore: num(data.riskScore ?? data.risk?.score),
      top10HolderPct: num(data.top10 ?? data.top10HolderPct),
      mintAuthority: mintAuth,
      freezeAuthority: freezeAuth,
      mintRenounced: mintAuth == null || mintAuth === "null" || mintAuth === "",
      freezeRenounced: freezeAuth == null || freezeAuth === "null" || freezeAuth === "",
    };
  }

  async tokenHolders(mint: string): Promise<TokenHolders | null> {
    if (!this.apiKey) return null;
    const data = await this.fetchJson(`/tokens/${mint}/holders`);
    if (!data) return null;
    const total = data.total || 0;
    const top = (data.accounts || []).slice(0, 100).map((a: any) => ({
      wallet: a.wallet,
      amount: a.amount || 0,
      percentage: a.percentage || 0,
    }));
    const top10 = top.slice(0, 10);
    const top10Pct =
      top10.length > 0
        ? top10.reduce(
            (s: number, a: { percentage: number }) =>
              s + (typeof a.percentage === "number" ? a.percentage : 0),
            0,
          )
        : null;
    // ST sometimes returns percentage as 0–1
    const normalized =
      top10Pct != null && top10Pct > 0 && top10Pct <= 1.5 ? top10Pct * 100 : top10Pct;
    return { total, top, top10Pct: normalized };
  }

  /**
   * Chart/OHLCV if exposed by ST (best-effort). Returns empty array on failure.
   * Useful when Birdeye is missing; not required for core funnel.
   */
  async chart(
    mint: string,
    opts: { type?: string; time_from?: number; time_to?: number } = {},
  ): Promise<Array<{ unixTime: number; c: number }>> {
    if (!this.apiKey) return [];
    const params: Record<string, unknown> = {};
    if (opts.type) params.type = opts.type;
    if (opts.time_from) params.time_from = opts.time_from;
    if (opts.time_to) params.time_to = opts.time_to;
    const data = await this.fetchJson(`/chart/${mint}`, params);
    const items = Array.isArray(data) ? data : data?.items ?? data?.data ?? [];
    if (!Array.isArray(items)) return [];
    return items
      .map((i: any) => ({
        unixTime: Number(i.unixTime ?? i.time ?? i.t ?? 0),
        c: Number(i.c ?? i.close ?? i.price ?? 0),
      }))
      .filter((i) => i.unixTime > 0 && i.c > 0);
  }
}
