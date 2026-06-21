/**
 * GMGN (Solana memecoin analytics) — smart-money / token-security signals.
 *
 * NOTE: gmgn.ai is behind a Cloudflare browser challenge, so a plain server-side
 * fetch is answered with a 403 "Just a moment…" page rather than JSON. This
 * provider is wired into the flow and will return data the moment a reachable
 * endpoint is available (a partner/API host or a `cf_clearance` cookie via
 * GMGN_API_KEY / GMGN_COOKIE); until then it fails closed (returns null) so the
 * on-chain agent simply proceeds on Bitquery data without it.
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
    if (!this.key) return null;
    try {
      const res = await fetch(`https://gmgn.ai/api/v1/token_security/sol/${mint}`, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
          "X-API-KEY": this.key,
          ...(this.cookie ? { Cookie: this.cookie } : {}),
        },
      });
      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok || !contentType.includes("application/json")) return null; // CF challenge / blocked
      const body = (await res.json()) as { data?: Record<string, unknown> };
      const d = body.data ?? {};
      const numOrNull = (v: unknown) => (typeof v === "number" ? v : null);
      const boolOrNull = (v: unknown) => (typeof v === "boolean" ? v : null);
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
      };
    } catch {
      return null;
    }
  }
}
