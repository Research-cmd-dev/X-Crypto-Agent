/**
 * GMGN (Solana memecoin analytics) — smart-money, risk, holders, traders via GMGN Agent API.
 *
 * Per https://docs.gmgn.ai/index/gmgn-agent-api :
 * - For AI/agent use: npx skills add GMGNAI/gmgn-skills
 * - Get API key: Generate keypair locally, upload public key at https://gmgn.ai/ai
 * - Use GMGN_API_KEY (and GMGN_PRIVATE_KEY if trading).
 * - Provides rich data without raw on-chain parsing: token security, smart money,
 *   holders, traders, risk (snipers/insiders/bundlers), trending/new tokens.
 *
 * This provider prefers official key auth. Falls back to cookie if needed.
 * Returns null on CF block or missing key (graceful in onchain-agent).
 *
 * Real-time: See scripts/watch-gmgn.ts (raw WS to wss://gmgn.ai/ws).
 * Channels include new_pools, token_launch, wallet/smart money trades.
 */
export interface GmgnData {
  /** Smart-money / notable-buyer summary, if exposed. */
  smartMoney: string | null;
  /** True if mint authority is renounced (safer). */
  mintRenounced: boolean | null;
  /** True if freeze authority is renounced (safer). */
  freezeRenounced: boolean | null;
  /** Top-10 holder concentration percent, if exposed. */
  top10HolderPct: number | null;

  /** Additional rich signals from GMGN Agent API / data (when available). */
  riskScore?: number | null;           // overall risk 1-10 or similar
  smartMoneyCount?: number | null;     // # of smart money wallets holding
  holderCount?: number | null;
  topTraders?: number | null;          // activity
  ratTraderRate?: number | null;       // % from "rat" / suspicious wallets
}

export class GmgnProvider {
  private readonly key?: string;
  private readonly cookie?: string;

  constructor(key = process.env.GMGN_API_KEY, cookie = process.env.GMGN_COOKIE) {
    this.key = key;
    this.cookie = cookie;
  }

  /** Best-effort token info. Returns null when GMGN is unreachable / Cloudflare-gated. */
  async tokenInfo(mint: string): Promise<GmgnData | null> {
    // Prefer gmgn-cli (from GMGN Agent API skills) for structured rich data when available
    try {
      const { execSync } = await import("child_process");
      const out = execSync(`npx gmgn-cli token info --chain sol --address ${mint} --raw`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env, GMGN_API_KEY: this.key || process.env.GMGN_API_KEY },
      });
      const parsed = JSON.parse(out);
      const d = parsed.data || parsed;
      return this.parseGmgnData(d);
    } catch {
      // fall through to direct API
    }

    if (!this.key) return null;
    try {
      const headers: Record<string, string> = {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json",
        "x-api-key": this.key,
        "X-API-KEY": this.key,
        "X-APIKEY": this.key,
      };
      if (this.cookie) headers["Cookie"] = this.cookie;

      let res = await fetch(`https://gmgn.ai/api/v1/token_security/sol/${mint}`, { headers });
      let contentType = res.headers.get("content-type") ?? "";
      if (!res.ok || !contentType.includes("application/json")) {
        res = await fetch(`https://gmgn.ai/defi/quotation/v1/token/info?chain=sol&address=${mint}`, { headers });
        contentType = res.headers.get("content-type") ?? "";
        if (!res.ok || !contentType.includes("application/json")) return null;
      }
      const body = (await res.json()) as { data?: Record<string, unknown> };
      const d = body.data ?? {};
      return this.parseGmgnData(d);
    } catch {
      return null;
    }
  }

  private parseGmgnData(d: Record<string, unknown>): GmgnData {
    const numOrNull = (v: unknown) => (typeof v === "number" ? v : null);
    const boolOrNull = (v: unknown) => (typeof v === "boolean" ? v : null);
    const strOrNull = (v: unknown) => (v != null ? String(v) : null);

    return {
      smartMoney:
        d.smart_money != null
          ? String(d.smart_money)
          : d.smartMoney != null
            ? String(d.smartMoney)
            : null,
      mintRenounced: boolOrNull(d.renounced_mint ?? d.mintRenounced),
      freezeRenounced: boolOrNull(d.renounced_freeze ?? d.freezeRenounced),
      top10HolderPct: numOrNull(d.top_10_holder_rate ?? d.top10HolderPct),

      // Extra from GMGN agent / quotation data
      riskScore: numOrNull(d.risk_score ?? d.riskScore ?? (d.security as any)?.score),
      smartMoneyCount: numOrNull(d.smart_money_count ?? d.smartMoneyCount ?? d.smart_degen_count),
      holderCount: numOrNull(d.holder_count ?? d.holders),
      topTraders: numOrNull(d.top_traders ?? d.trader_count),
      ratTraderRate: numOrNull(d.rat_trader_amount_rate ?? d.ratTraderRate),
    };
  }
}
