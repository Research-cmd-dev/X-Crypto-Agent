/**
 * Seed the signal_sources table with a starter set of curated accounts and
 * search queries. Run with: `npm run seed`
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment.
 */
import { supabaseServer } from "@/lib/supabase/server";

const SEED: { kind: "account" | "query"; value: string; label: string; weight: number }[] = [
  // ── Smart-money / low-float signal accounts (the primary alpha funnel) ──────
  // Their @mentions surface early gems before the crowd. Highest weight.
  // Edit this list to match the alpha accounts YOU trust.
  { kind: "account", value: "lowfloating", label: "Low-float gem hunter", weight: 1.0 },
  { kind: "account", value: "0xQuit", label: "Onchain analyst", weight: 0.9 },
  { kind: "account", value: "DefiIgnas", label: "DeFi researcher", weight: 0.9 },
  { kind: "account", value: "thedefiedge", label: "DeFi alpha", weight: 0.85 },
  { kind: "account", value: "Cryptot_Maxie", label: "Microcap hunter", weight: 0.85 },

  // ── Low-float / early launch search queries (secondary funnel, noisier) ─────
  { kind: "query", value: '("low float" OR "low cap" OR "stealth launch" OR "fair launch") (token OR coin) -is:retweet lang:en', label: "Low-float launch search", weight: 0.8 },
  { kind: "query", value: '("just launched" OR "presale live" OR "now live") (microcap OR "100x" OR gem) -is:retweet lang:en', label: "Early gem search", weight: 0.7 },
  { kind: "query", value: "(mainnet OR testnet) (launch OR live) (defi OR perps OR L2 OR restaking) -is:retweet lang:en", label: "Infra launch search", weight: 0.6 },
];

async function main() {
  const sb = supabaseServer();
  const { data, error } = await sb
    .from("signal_sources")
    .upsert(
      SEED.map((s) => ({ kind: s.kind, value: s.value, label: s.label, weight: s.weight, active: true })),
      { onConflict: "kind,value" },
    )
    .select("id, kind, value");

  if (error) {
    console.error("Seed failed:", error.message);
    process.exit(1);
  }
  console.log(`Seeded ${data?.length ?? 0} signal sources.`);
}

main();
