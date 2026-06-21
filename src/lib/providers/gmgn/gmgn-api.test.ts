import { describe, it, expect } from "vitest";
import {
  mapTokenSummary,
  mapTokenSecurity,
  mapTokenTrader,
} from "@/lib/providers/gmgn/gmgn-api";

describe("GMGN mappers", () => {
  it("maps a rank/summary item with mixed string/number/yes-no shapes", () => {
    const s = mapTokenSummary({
      address: "A",
      symbol: "x",
      name: "X Token",
      price: "0.5",
      market_cap: 1_000_000,
      volume_24h: 50_000,
      liquidity: 80_000,
      holder_count: "100",
      smart_degen_count: 4,
      is_honeypot: "no",
      rug_ratio: 0.1,
      price_change_percent24h: 12,
      dev_team_hold_rate: 0.03,
      platform: "pump_fun",
      twitter_username: "foo",
    });
    expect(s.address).toBe("A");
    expect(s.priceUsd).toBe(0.5);
    expect(s.marketCapUsd).toBe(1_000_000);
    expect(s.holderCount).toBe(100);
    expect(s.smartMoneyCount).toBe(4);
    expect(s.isHoneypot).toBe(false);
    expect(s.launchpad).toBe("pump_fun");
    expect(s.twitter).toBe("https://x.com/foo");
  });

  it("maps security, normalizing fractional tax to percent and burn status to a boolean", () => {
    const sec = mapTokenSecurity(
      {
        renounced_mint: "yes",
        renounced_freeze_account: "no",
        burn_status: "burned",
        top_10_holder_rate: 0.4,
        buy_tax: 0.05, // fraction → 5%
        sell_tax: 5, // already percent
        rug_ratio: 0.2,
        is_honeypot: "unknown",
      },
      "A",
    );
    expect(sec).toMatchObject({
      address: "A",
      renouncedMint: true,
      renouncedFreeze: false,
      lpBurnedOrLocked: true,
      top10HolderRate: 0.4,
      buyTaxPct: 5,
      sellTaxPct: 5,
      isHoneypot: null, // "unknown" → null
    });
  });

  it("maps a trader and filters unknown wallet tags", () => {
    const t = mapTokenTrader({
      wallet_address: "w",
      wallet_tags: ["smart_degen", "not_a_real_tag"],
      realized_profit: 1000,
      balance_usd_value: 500,
      buy_count: 2,
      sell_count: 1,
    });
    expect(t.wallet).toBe("w");
    expect(t.tags).toEqual(["smart_degen"]);
    expect(t.realizedPnlUsd).toBe(1000);
    expect(t.balanceUsd).toBe(500);
  });
});
