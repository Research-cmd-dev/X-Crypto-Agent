/**
 * Seed the signal_sources table with a starter set of curated accounts and
 * search queries. Run with: `npm run seed`
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment.
 */
import { supabaseServer } from "@/lib/supabase/server";

const SEED: { kind: "account" | "query"; value: string; label: string; weight: number }[] = [
  // Broad search queries (recent-search).
  { kind: "query", value: '("new crypto" OR "just launched" OR "presale") (token OR coin OR protocol) -is:retweet lang:en', label: "Broad launch search", weight: 1.0 },
  { kind: "query", value: "(mainnet OR testnet) (launch OR live) (defi OR perps OR L2) -is:retweet lang:en", label: "Infra launch search", weight: 0.9 },
  // Curated signal accounts whose mentions surface new projects.
  { kind: "account", value: "crypto", label: "Example curated account", weight: 0.8 },
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
