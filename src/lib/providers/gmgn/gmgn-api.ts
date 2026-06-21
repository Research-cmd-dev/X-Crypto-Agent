import { fetchWithRetry } from "@/lib/util/fetch";
import { cached } from "@/lib/cache/store";
import type {
  GmgnProvider,
  TokenSummary,
  TokenSecurity,
  TokenTrader,
  TrendingOptions,
  WalletTag,
} from "@/lib/providers/gmgn/types";

const BASE = "https://gmgn.ai";
const WALLET_TAGS: WalletTag[] = ["smart_degen", "insider", "bundler", "sniper", "whale", "fresh", "kol"];

// ── Coercion helpers (GMGN returns mixed string/number/yes-no shapes) ────────

type Raw = Record<string, unknown>;

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Tri-state boolean: true/false/null from booleans or "yes"/"no"/"unknown". */
function tri(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (s === "yes" || s === "true" || s === "1") return true;
    if (s === "no" || s === "false" || s === "0") return false;
  }
  return null;
}

/** Tax may arrive as a fraction (0.05) or a percent (5). Normalize to percent. */
function pct(v: unknown): number | null {
  const n = num(v);
  if (n == null) return null;
  return n > 0 && n <= 1 ? n * 100 : n;
}

function pickFirst(raw: Raw, keys: string[]): unknown {
  for (const k of keys) if (raw[k] != null) return raw[k];
  return undefined;
}

// ── Pure mappers (exported for unit tests — no network) ──────────────────────

export function mapTokenSummary(raw: Raw, chain = "sol"): TokenSummary {
  const created = num(pickFirst(raw, ["open_timestamp", "created_timestamp", "creation_timestamp"]));
  const ageMinutes = created != null ? Math.max(0, (Date.now() / 1000 - created) / 60) : null;
  const twitterUser = pickFirst(raw, ["twitter_username", "twitter"]);
  const link = (raw.link as Raw | undefined) ?? {};
  return {
    address: String(pickFirst(raw, ["address", "token_address", "contract_address"]) ?? ""),
    symbol: String(pickFirst(raw, ["symbol", "ticker"]) ?? ""),
    name: String(raw.name ?? ""),
    chain,
    priceUsd: num(raw.price),
    marketCapUsd: num(pickFirst(raw, ["market_cap", "marketcap", "usd_market_cap"])),
    volume24hUsd: num(pickFirst(raw, ["volume", "volume_24h", "volume_24h_usd"])),
    liquidityUsd: num(raw.liquidity),
    holderCount: num(pickFirst(raw, ["holder_count", "holders"])),
    smartMoneyCount: num(pickFirst(raw, ["smart_degen_count", "smart_money_count"])),
    priceChange24hPct: num(pickFirst(raw, ["price_change_percent24h", "price_change_24h", "price_change_percent"])),
    rugRatio: num(raw.rug_ratio),
    isHoneypot: tri(raw.is_honeypot),
    devHoldRate: num(pickFirst(raw, ["dev_team_hold_rate", "creator_token_hold_rate"])),
    launchpad: (pickFirst(raw, ["launchpad", "platform", "pool_type"]) as string | undefined) ?? null,
    ageMinutes,
    migratedAt: num(pickFirst(raw, ["completed_timestamp", "migrated_at", "graduated_at", "completed_at"])),
    twitter: typeof twitterUser === "string"
      ? (twitterUser.startsWith("http") ? twitterUser : `https://x.com/${twitterUser.replace(/^@/, "")}`)
      : ((link.twitter as string | undefined) ?? null),
    website: (link.website as string | undefined) ?? (raw.website as string | undefined) ?? null,
  };
}

export function mapTokenSecurity(raw: Raw, address: string): TokenSecurity {
  const burn = String(pickFirst(raw, ["burn_status", "lp_burn_status"]) ?? "").toLowerCase();
  const lpBurnedOrLocked =
    burn === "burned" || burn === "locked" ? true : burn === "unknown" || burn === "" ? tri(raw.lp_burned) : false;
  return {
    address,
    renouncedMint: tri(pickFirst(raw, ["renounced_mint", "mint_renounced"])),
    renouncedFreeze: tri(pickFirst(raw, ["renounced_freeze_account", "freeze_renounced"])),
    lpBurnedOrLocked,
    top10HolderRate: num(pickFirst(raw, ["top_10_holder_rate", "top10_holder_rate"])),
    buyTaxPct: pct(raw.buy_tax),
    sellTaxPct: pct(raw.sell_tax),
    rugRatio: num(raw.rug_ratio),
    isHoneypot: tri(raw.is_honeypot),
  };
}

export function mapTokenTrader(raw: Raw): TokenTrader {
  const rawTags = (pickFirst(raw, ["wallet_tags", "tags"]) as unknown[] | undefined) ?? [];
  const tags = rawTags
    .map((t) => String(t))
    .filter((t): t is WalletTag => (WALLET_TAGS as string[]).includes(t));
  return {
    wallet: String(pickFirst(raw, ["wallet_address", "address", "wallet"]) ?? ""),
    tags,
    realizedPnlUsd: num(pickFirst(raw, ["realized_pnl", "realized_profit"])),
    balanceUsd: num(pickFirst(raw, ["balance_usd_value", "usd_value", "balance_usd"])),
    buyCount: num(raw.buy_count),
    sellCount: num(raw.sell_count),
    boughtUsd: num(pickFirst(raw, ["bought_usd", "buy_volume_usd", "history_bought_cost"])),
    soldUsd: num(pickFirst(raw, ["sold_usd", "sell_volume_usd"])),
  };
}

/** Extract a list of raw items from GMGN's various response envelopes. */
function listOf(body: unknown): Raw[] {
  const b = body as { data?: unknown };
  const d = b?.data as Raw | Raw[] | undefined;
  if (Array.isArray(d)) return d as Raw[];
  if (d && typeof d === "object") {
    for (const key of ["rank", "list", "tokens", "items", "holders", "traders", "completed", "migrated"]) {
      const v = (d as Raw)[key];
      if (Array.isArray(v)) return v as Raw[];
    }
  }
  return [];
}

function firstOf(body: unknown): Raw | null {
  const b = body as { data?: unknown };
  const d = b?.data;
  if (d && typeof d === "object" && !Array.isArray(d)) return d as Raw;
  const list = listOf(body);
  return list[0] ?? null;
}

/**
 * Thin GMGN API client. Requires GMGN_API_KEY. Rate limit is ~1 req / 5s, so
 * every call is cached and discovery should prefer the rank payload (which
 * already carries smart-money count, rug ratio, honeypot, dev hold, liquidity)
 * over per-token enrichment. Read endpoints use the API key header; the Ed25519
 * request-signing GMGN documents is only required for trading endpoints (not
 * used here) — confirm header specifics against docs when wiring a live key.
 */
export class GmgnApiProvider implements GmgnProvider {
  private readonly key?: string;

  constructor(key = process.env.GMGN_API_KEY) {
    this.key = key;
  }

  private headers(): HeadersInit {
    return this.key ? { Authorization: `Bearer ${this.key}`, "x-api-key": this.key } : {};
  }

  private async get(path: string, params: Record<string, string | undefined>): Promise<unknown> {
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
    const res = await fetchWithRetry(url, { headers: this.headers() }).catch(() => null);
    if (!res || !res.ok) return null;
    return res.json().catch(() => null);
  }

  private async rank(path: string, opts: TrendingOptions): Promise<TokenSummary[]> {
    const chain = opts.chain ?? "sol";
    const params: Record<string, string | undefined> = {
      chain,
      interval: opts.interval ?? "1h",
      "order-by": opts.orderBy ?? "smart_degen_count",
      limit: String(opts.limit ?? 50),
      platform: opts.platforms?.join(","),
    };
    const cacheId = `${path}:${JSON.stringify(params)}`;
    const body = await cached("gmgn:rank", cacheId, 60, () => this.get(path, params));
    return listOf(body).map((r) => mapTokenSummary(r, chain));
  }

  trending(opts: TrendingOptions = {}): Promise<TokenSummary[]> {
    return this.rank("/v1/market/rank", opts);
  }

  newLaunches(opts: TrendingOptions = {}): Promise<TokenSummary[]> {
    return this.rank("/v1/market/trenches", opts);
  }

  /**
   * Recently migrated/graduated tokens (`/v1/trenches/migrated`, `data.completed[]`).
   * No server-side time filter, so the caller dedups against existing candidates
   * to pick out "new since last poll" (graduation volume is ~1–3 per 30-min poll).
   */
  async recentMigrations(opts: TrendingOptions = {}): Promise<TokenSummary[]> {
    const chain = opts.chain ?? "sol";
    const body = await cached("gmgn:migrated", chain, 60, () =>
      this.get("/v1/trenches/migrated", { chain, limit: String(opts.limit ?? 50) }),
    );
    return listOf(body).map((r) => mapTokenSummary(r, chain));
  }

  async tokenInfo(address: string, chain = "sol"): Promise<TokenSummary | null> {
    const body = await cached("gmgn:token-info", `${chain}:${address}`, 300, () =>
      this.get("/v1/token/info", { chain, address }),
    );
    const raw = firstOf(body);
    return raw ? mapTokenSummary({ address, ...raw }, chain) : null;
  }

  async tokenSecurity(address: string, chain = "sol"): Promise<TokenSecurity | null> {
    const body = await cached("gmgn:token-security", `${chain}:${address}`, 300, () =>
      this.get("/v1/token/security", { chain, address }),
    );
    const raw = firstOf(body);
    return raw ? mapTokenSecurity(raw, address) : null;
  }

  async topTraders(address: string, chain = "sol"): Promise<TokenTrader[]> {
    const body = await cached("gmgn:top-traders", `${chain}:${address}`, 120, () =>
      this.get("/v1/market/token_top_traders", { chain, address }),
    );
    return listOf(body).map(mapTokenTrader);
  }
}
