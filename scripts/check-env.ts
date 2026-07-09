/**
 * Report which API keys / env vars are present (never prints secret values).
 *
 *   npm run check-env
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv(path: string, into: Record<string, string>) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k && into[k] === undefined) into[k] = v;
  }
}

const env: Record<string, string> = { ...process.env } as Record<string, string>;
const root = resolve(process.cwd());
const files = [".env", ".env.local"].map((f) => resolve(root, f)).filter(existsSync);
for (const f of files) loadDotEnv(f, env);

type Need = "required" | "recommended" | "optional" | "pipeline" | "jobs";

const KEYS: Array<{ key: string; need: Need; purpose: string }> = [
  { key: "XAI_API_KEY", need: "required", purpose: "Grok LLM (analyze / scout)" },
  { key: "GROK_MODEL", need: "optional", purpose: "Model override (default grok-3)" },
  { key: "X_API_BEARER_TOKEN", need: "required", purpose: "X discovery + profiles" },
  { key: "SOLANATRACKER_API_KEY", need: "recommended", purpose: "Graduations + holders + launch funnel" },
  { key: "BIRDEYE_API_KEY", need: "recommended", purpose: "Price + outcome OHLCV backfill" },
  { key: "BITQUERY_API_KEY", need: "optional", purpose: "Traders/trades + historical fallback" },
  { key: "GMGN_API_KEY", need: "optional", purpose: "Risk / smart-money enrichment" },
  { key: "GITHUB_TOKEN", need: "optional", purpose: "GitHub rate limits" },
  { key: "SUPABASE_URL", need: "pipeline", purpose: "DB server" },
  { key: "SUPABASE_SERVICE_ROLE_KEY", need: "pipeline", purpose: "DB server auth" },
  { key: "NEXT_PUBLIC_SUPABASE_URL", need: "pipeline", purpose: "Dashboard browser" },
  { key: "NEXT_PUBLIC_SUPABASE_ANON_KEY", need: "pipeline", purpose: "Dashboard browser" },
  { key: "TRIGGER_SECRET_KEY", need: "jobs", purpose: "Trigger.dev worker" },
  { key: "TRIGGER_PROJECT_REF", need: "jobs", purpose: "Trigger.dev project" },
];

function classify(val: string | undefined): "MISSING" | "PLACEHOLDER" | "SET" {
  if (val == null || val === "") return "MISSING";
  const low = val.toLowerCase();
  if (
    low.includes("xxxxxxxx") ||
    low.includes("your_") ||
    low.includes("changeme") ||
    low === "gmgn_..." ||
    low.startsWith("proj_xxxx")
  ) {
    return "PLACEHOLDER";
  }
  return "SET";
}

function redacted(val: string): string {
  if (val.length <= 8) return `len=${val.length}`;
  return `len=${val.length} ${val.slice(0, 4)}…${val.slice(-4)}`;
}

console.log("\n🔐 Environment check (secrets redacted)\n");
if (files.length) console.log(`Loaded: ${files.map((f) => f.replace(root + "/", "")).join(", ")}`);
else console.log("No .env / .env.local found — checking process env only.");
console.log();

const pad = (s: string, n: number) => s.padEnd(n);
console.log(`${pad("KEY", 32)}${pad("STATUS", 12)}${pad("NEED", 14)}DETAIL`);
console.log("-".repeat(100));

const gaps: string[] = [];
for (const { key, need, purpose } of KEYS) {
  const st = classify(env[key]);
  const detail = st === "SET" ? redacted(env[key]) : purpose;
  console.log(`${pad(key, 32)}${pad(st, 12)}${pad(need, 14)}${detail}`);
  if (st !== "SET" && need !== "optional") gaps.push(`${key} (${need})`);
}

console.log("\nCapability matrix:");
const has = (k: string) => classify(env[k]) === "SET";
const row = (name: string, ok: boolean, need: string) =>
  console.log(`  ${ok ? "✅" : "❌"} ${pad(name, 28)} ${ok ? "ready" : "blocked — " + need}`);

row("Unit tests / launchScore", true, "");
row("rank-launches / migrations", has("SOLANATRACKER_API_KEY") || has("BITQUERY_API_KEY"), "SOLANATRACKER or BITQUERY");
row("Outcome backfill", has("BIRDEYE_API_KEY") && (has("SOLANATRACKER_API_KEY") || has("BITQUERY_API_KEY")), "BIRDEYE + ST/BITQUERY");
row("Full analyze (Grok+X)", has("XAI_API_KEY") && has("X_API_BEARER_TOKEN"), "XAI + X bearer");
row("Dashboard + persist", has("SUPABASE_URL") && has("SUPABASE_SERVICE_ROLE_KEY"), "Supabase");
row("Scheduled jobs", has("TRIGGER_SECRET_KEY") && has("TRIGGER_PROJECT_REF"), "Trigger.dev");

if (gaps.length) {
  console.log("\nMissing / placeholder (non-optional):");
  for (const g of gaps) console.log(`  · ${g}`);
  console.log("\nCopy .env.example → .env and fill values, or set Codespace secrets with these names.\n");
  process.exitCode = 1;
} else {
  console.log("\nAll non-optional keys look set.\n");
}
