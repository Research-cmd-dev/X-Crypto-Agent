/**
 * CLI: analyze a single X account by handle using the REAL X API + agent graph.
 * Simulates "the discovery scanner flagged this account" and runs the full
 * orchestrator swarm (X → website ∥ github ∥ price → scorer) on it.
 *
 *   npm run analyze -- <handle | x.com URL>
 *   npm run analyze -- c0mputeAI
 *   npm run analyze -- https://x.com/c0mputeAI
 *
 * Requires ANTHROPIC_API_KEY (agents call Claude) and X_API_BEARER_TOKEN (real
 * X API v2). Optional: GITHUB_TOKEN, COINGECKO_API_KEY. Does NOT touch Supabase
 * — it runs the graph in-memory and prints the report; use the Trigger.dev
 * pipeline (`analyzeCandidate`) for a persisted run.
 */
import { XApiProvider } from "@/lib/providers/x";
import { GithubProvider } from "@/lib/providers/github";
import { PriceProvider } from "@/lib/providers/price";
import { runGraph } from "@/lib/orchestrator/graph";
import type { AgentContext } from "@/lib/agents/types";

/** Accept a bare handle, `@handle`, or any x.com/twitter.com profile URL. */
function parseHandle(input: string | undefined): string | null {
  if (!input) return null;
  let h = input.trim();
  if (h.includes("/")) h = h.split("/").filter(Boolean).pop() ?? h; // last path segment
  h = h.replace(/^@/, "").split("?")[0].trim();
  return h || null;
}

async function main() {
  const handle = parseHandle(process.argv[2]);
  if (!handle) {
    console.error("Usage: npm run analyze -- <x-handle | x.com URL>");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY — the agents call Claude.");
    process.exit(1);
  }
  if (!process.env.X_API_BEARER_TOKEN) {
    console.error("Set X_API_BEARER_TOKEN — this runner hits the real X API.");
    process.exit(1);
  }
  // serverEnv() validates Supabase vars even though this script never persists.
  process.env.SUPABASE_URL ??= "https://mock.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "mock";

  const ctx: AgentContext = {
    candidate: { id: "manual-run", handle, xUserId: null, displayName: null },
    providers: {
      x: new XApiProvider(),
      github: new GithubProvider(),
      price: new PriceProvider(),
    },
    xUser: null,
    hints: { websiteUrl: null, githubUrl: null },
    log: (m, meta) => console.log(`[analyze] ${m}`, meta ?? ""),
  };

  console.log(`\n🔎 Analyzing @${handle} via the real X API + agent swarm …\n`);
  const started = Date.now();
  const result = await runGraph(ctx);
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  console.log("\n=== ACCOUNT ===");
  console.log(result.report.account);
  console.log("\n=== SCORES ===");
  console.log(result.scores);
  console.log("\n=== RED FLAGS ===");
  console.log(result.report.redFlags.length ? result.report.redFlags : "(none)");
  console.log("\n=== WEBSITE / GITHUB / PRICE ===");
  console.log({
    website: { url: result.report.website.url, detected: result.report.website.detected, score: result.report.website.score },
    github: { url: result.report.github.url, detected: result.report.github.detected, stars: result.report.github.stars, score: result.report.github.score },
    price: result.report.price,
  });
  console.log("\n=== SUMMARY ===");
  console.log(result.report.summary);
  if (result.errors.length) {
    console.log("\n=== DEGRADED NODES (failure-tolerant) ===");
    console.log(result.errors);
  }
  console.log(`\n✅ Done in ${secs}s — verdict: ${result.scores.verdict} (${result.scores.overall}/100)\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
