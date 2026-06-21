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
