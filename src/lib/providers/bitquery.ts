/**
 * Bitquery (Solana, EAP GraphQL) — on-chain traction signals for a token mint:
 * unique holders, 24h active traders, 24h trade count, first-trade (launch) time,
 * and latest USD price. This is the strongest *early* signal: real holders and
 * active traders shortly after launch separate live projects from empty shells.
 */
export interface OnchainData {
  symbol: string | null;
  priceUsd: number | null;
  holderCount: number | null;
  traders24h: number | null;
  trades24h: number | null;
  firstTradeAt: string | null;
}

const EMPTY: OnchainData = {
  symbol: null,
  priceUsd: null,
  holderCount: null,
  traders24h: null,
  trades24h: null,
  firstTradeAt: null,
};

const ENDPOINT = "https://streaming.bitquery.io/eap";
/** pump.fun bonding-curve program — emits a `migrate` instruction on graduation. */
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export interface Migration {
  mint: string;
  migratedAt: string;
}

export interface TokenMetadata {
  name: string | null;
  symbol: string | null;
  twitter: string | null;
  website: string | null;
  telegram: string | null;
}

interface RawResult {
  Solana?: {
    latest?: { Trade?: { Currency?: { Symbol?: string }; PriceInUSD?: number } }[];
    first?: { Block?: { Time?: string } }[];
    day?: { trades?: string; traders?: string }[];
    owners?: { holders?: string }[];
  };
}

export class BitqueryProvider {
  private readonly token?: string;

  constructor(token = process.env.BITQUERY_API_KEY) {
    this.token = token;
  }

  /**
   * pump.fun tokens that graduated (migrated off the bonding curve to the AMM)
   * since `sinceISO`. The migrate instruction carries the token mint in its
   * account list (pump.fun mints end in "pump"; index 2 is the mint otherwise).
   * Returns the most-recent `limit` plus the total count in the window.
   */
  async recentMigrations(
    sinceISO: string,
    limit = 50,
  ): Promise<{ migrations: Migration[]; total: number }> {
    if (!this.token) return { migrations: [], total: 0 };
    const where = `{Instruction: {Program: {Address: {is: "${PUMP_PROGRAM}"}, Method: {is: "migrate"}}}, Block: {Time: {since: $since}}}`;
    const query = `query ($since: DateTime!, $lim: Int!) {
      Solana {
        list: Instructions(where: ${where}, orderBy: {descending: Block_Time}, limit: {count: $lim}) {
          Block { Time }
          Instruction { Accounts { Address } }
        }
        total: Instructions(where: ${where}) { count }
      }
    }`;

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ query, variables: { since: sinceISO, lim: limit } }),
    });
    if (!res.ok) return { migrations: [], total: 0 };
    const body = (await res.json()) as {
      data?: {
        Solana?: {
          list?: { Block?: { Time?: string }; Instruction?: { Accounts?: { Address?: string }[] } }[];
          total?: { count?: string }[];
        };
      };
      errors?: unknown;
    };
    if (body.errors || !body.data?.Solana) return { migrations: [], total: 0 };

    const seen = new Set<string>();
    const migrations: Migration[] = [];
    for (const row of body.data.Solana.list ?? []) {
      const accs = (row.Instruction?.Accounts ?? [])
        .map((a) => a.Address)
        .filter((a): a is string => Boolean(a));
      const mint = accs.find((a) => /pump$/i.test(a)) ?? accs[2] ?? null;
      if (!mint || seen.has(mint)) continue;
      seen.add(mint);
      migrations.push({ mint, migratedAt: row.Block?.Time ?? "" });
    }
    const total = Number(body.data.Solana.total?.[0]?.count ?? migrations.length);
    return { migrations, total };
  }

  /**
   * Token name/symbol + socials. The on-chain metadata points at an off-chain
   * JSON URI (pump.fun → IPFS) that carries the project's twitter/website — the
   * link from a migrated mint to an analyzable X account.
   */
  async tokenMetadata(mint: string): Promise<TokenMetadata | null> {
    if (!this.token) return null;
    const query = `{Solana{DEXTradeByTokens(limit:{count:1},orderBy:{descending:Block_Time},where:{Trade:{Currency:{MintAddress:{is:"${mint}"}}}}){Trade{Currency{Name Symbol Uri}}}}}`;
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: { Solana?: { DEXTradeByTokens?: { Trade?: { Currency?: { Name?: string; Symbol?: string; Uri?: string } } }[] } };
      errors?: unknown;
    };
    if (body.errors) return null;
    const cur = body.data?.Solana?.DEXTradeByTokens?.[0]?.Trade?.Currency;
    if (!cur) return null;

    let twitter: string | null = null;
    let website: string | null = null;
    let telegram: string | null = null;
    if (cur.Uri) {
      try {
        const meta = (await fetch(cur.Uri, { signal: AbortSignal.timeout(6000) }).then((r) =>
          r.json(),
        )) as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === "string" && v ? v : null);
        twitter = str(meta.twitter);
        website = str(meta.website);
        telegram = str(meta.telegram);
      } catch {
        // IPFS gateway slow/unavailable — socials simply stay null.
      }
    }
    return { name: cur.Name ?? null, symbol: cur.Symbol ?? null, twitter, website, telegram };
  }

  async tokenOnchain(mint: string): Promise<OnchainData> {
    if (!this.token) return { ...EMPTY };
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const query = `query ($t: String!, $since: DateTime!) {
      Solana {
        latest: DEXTradeByTokens(limit: {count: 1}, orderBy: {descending: Block_Time}, where: {Trade: {Currency: {MintAddress: {is: $t}}}}) {
          Trade { Currency { Symbol } PriceInUSD }
        }
        first: DEXTradeByTokens(limit: {count: 1}, orderBy: {ascending: Block_Time}, where: {Trade: {Currency: {MintAddress: {is: $t}}}}) {
          Block { Time }
        }
        day: DEXTradeByTokens(where: {Trade: {Currency: {MintAddress: {is: $t}}}, Block: {Time: {since: $since}}}) {
          trades: count
          traders: uniq(of: Trade_Account_Owner)
        }
        owners: BalanceUpdates(where: {BalanceUpdate: {Currency: {MintAddress: {is: $t}}}}) {
          holders: uniq(of: BalanceUpdate_Account_Owner)
        }
      }
    }`;

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ query, variables: { t: mint, since } }),
    });
    if (!res.ok) return { ...EMPTY };
    const body = (await res.json()) as { data?: RawResult; errors?: unknown };
    if (body.errors || !body.data?.Solana) return { ...EMPTY };

    const S = body.data.Solana;
    const n = (v: string | undefined): number | null => (v != null ? Number(v) : null);
    return {
      symbol: S.latest?.[0]?.Trade?.Currency?.Symbol ?? null,
      priceUsd: S.latest?.[0]?.Trade?.PriceInUSD ?? null,
      firstTradeAt: S.first?.[0]?.Block?.Time ?? null,
      trades24h: n(S.day?.[0]?.trades),
      traders24h: n(S.day?.[0]?.traders),
      holderCount: n(S.owners?.[0]?.holders),
    };
  }
}
