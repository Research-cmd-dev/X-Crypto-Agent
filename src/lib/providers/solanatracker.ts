/**
 * Solana Tracker Data API provider (alternative to Bitquery for Pump.fun / on-chain data).
 * Base: https://data.solanatracker.io
 * Auth: x-api-key header.
 *
 * Good for:
 * - Recent graduated/migrated tokens (pump.fun etc.)
 * - Token info, holders, price context
 *
 * Real-time: see scripts/watch-migrations.ts (uses official @solana-tracker/data-api Datastream)
 *   - subscribe.graduated()
 *   - subscribe.graduating()
 * Connection: wss://datastream.solanatracker.io/{KEY}
 */

export interface GraduatedToken {
  mint: string;
  graduatedAt?: string; // approx created or last pool
  symbol: string | null;
  twitter: string | null;
  marketCapUsd?: number;
  liquidityUsd?: number;
}

export interface TokenHolders {
  total: number;
  top: Array<{ wallet: string; amount: number; percentage: number }>;
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
}

const BASE = "https://data.solanatracker.io";

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
   * Uses /tokens/multi/graduated as direct replacement for Bitquery migrate queries.
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

    const grads: GraduatedToken[] = data.map((item: any) => {
      const t = item.token || {};
      const p = (item.pools && item.pools[0]) || {};
      let tw = "";
      const ss = t.strictSocials || t.socials || {};
      if (typeof ss === "object") tw = ss.twitter || "";
      if (tw) tw = tw.replace(/.*\//, "").replace(/^@/, "");
      const mc = p.marketCap ? p.marketCap.usd || p.marketCap.quote : undefined;
      const liq = p.liquidity ? p.liquidity.usd : undefined;
      return {
        mint: t.mint,
        graduatedAt: t.creation && t.creation.created_time ? new Date(t.creation.created_time * 1000).toISOString() : undefined,
        symbol: t.symbol || null,
        twitter: tw || null,
        marketCapUsd: mc,
        liquidityUsd: liq,
      };
    }).filter((g: GraduatedToken) => g.mint);

    return { graduations: grads.slice(0, limit), total: data.length };
  }

  /**
   * Detailed token info (metadata, pools post-migration, etc.).
   */
  async tokenInfo(mint: string): Promise<SolanaTokenInfo | null> {
    if (!this.apiKey) return null;
    const data = await this.fetchJson(`/tokens/${mint}`);
    if (!data || !data.token) return null;
    const t = data.token;
    let tw = "", ws = "";
    const ss = t.strictSocials || t.socials || {};
    if (typeof ss === "object") {
      tw = ss.twitter || "";
      ws = ss.website || "";
    }
    if (tw) tw = tw.replace(/.*\//, "").replace(/^@/, "");
    return {
      name: t.name || null,
      symbol: t.symbol || null,
      mint: t.mint,
      twitter: tw || null,
      website: ws || null,
      image: t.image,
      createdTime: t.creation && t.creation.created_time,
      pools: data.pools || [],
    };
  }

  /**
   * Top holders (approximates on-chain holder data).
   */
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
    return { total, top };
  }
}
