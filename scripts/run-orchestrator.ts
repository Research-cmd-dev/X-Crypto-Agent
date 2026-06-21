/**
 * Dev runner: execute the agent graph on a sample candidate using the mock X
 * provider (no X API needed), then print the report + scores. The agents still
 * call Claude, so this requires ANTHROPIC_API_KEY (+ network). It does NOT touch
 * Supabase — it's a quick end-to-end smoke test of the orchestration + agents.
 *
 * Run with: `npm run scout`
 */
import { MockXProvider } from "@/lib/providers/x";
import { GithubProvider } from "@/lib/providers/github";
import { PriceProvider } from "@/lib/providers/price";
import { runGraph } from "@/lib/orchestrator/graph";
import type { AgentContext } from "@/lib/agents/types";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY to run the agents (they call Claude).");
    process.exit(1);
  }
  // X provider is mocked so this runs without a paid X API token.
  process.env.X_API_BEARER_TOKEN ??= "mock";
  process.env.SUPABASE_URL ??= "https://mock.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "mock";

  const ctx: AgentContext = {
    candidate: { id: "dev-run", handle: "exampledefi", xUserId: "1001", displayName: "ExampleDeFi" },
    providers: { x: new MockXProvider(), github: new GithubProvider(), price: new PriceProvider() },
    xUser: null,
    hints: { websiteUrl: null, githubUrl: null, contractAddress: null },
    log: (m, meta) => console.log(`[scout] ${m}`, meta ?? ""),
  };

  const result = await runGraph(ctx);
  console.log("\n=== SCORES ===");
  console.log(result.scores);
  console.log("\n=== RED FLAGS ===");
  console.log(result.report.redFlags);
  console.log("\n=== SUMMARY ===");
  console.log(result.report.summary);
  if (result.errors.length) {
    console.log("\n=== DEGRADED NODES ===");
    console.log(result.errors);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
