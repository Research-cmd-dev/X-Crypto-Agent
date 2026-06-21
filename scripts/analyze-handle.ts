/**
 * Ad-hoc analysis of a single real X handle through the full agent graph —
 * reproducing the discovery resolution (fetch profile → extract token from
 * bio/links → run x-analyzer + website + github + on-chain + scorer). Prints the
 * scores, on-chain section, red flags, and summary. Does NOT touch Supabase.
 *
 *   npm run analyze -- c0mputeAI
 *
 * Requires real keys: ANTHROPIC_API_KEY + X_API_BEARER_TOKEN (read the account),
 * and ideally GMGN_API_KEY (on-chain layer) + BIRDEYE_API_KEY (price). With egress
 * allowlisted for api.x.com / api.anthropic.com / gmgn.ai / birdeye.so.
 */
import { defaultProviders } from "@/lib/orchestrator";
import { runGraph } from "@/lib/orchestrator/graph";
import { extractSolanaToken } from "@/lib/discovery/token-link";
import type { AgentContext } from "@/lib/agents/types";

async function main() {
  const handle = process.argv[2]?.replace(/^@/, "").trim();
  if (!handle) {
    console.error("usage: npm run analyze -- <x_handle>");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY || !process.env.X_API_BEARER_TOKEN) {
    console.error("Missing keys: set ANTHROPIC_API_KEY + X_API_BEARER_TOKEN (and ideally GMGN_API_KEY).");
    process.exit(1);
  }
  // Supabase isn't used (no persist) — satisfy lazy env validation if touched.
  process.env.SUPABASE_URL ??= "https://mock.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "mock";

  const providers = defaultProviders();

  // Resolve the profile and (like discovery) extract a Solana token from bio/links.
  const user = await providers.x.getUserByHandle(handle).catch(() => null);
  if (!user) {
    console.error(`Could not resolve X profile @${handle} (check the handle / X_API_BEARER_TOKEN).`);
    process.exit(1);
  }
  const tokenAddress = extractSolanaToken(user.description, user.urls);
  console.log(`@${handle} (${user.name}) — followers: ${user.followersCount}, token resolved: ${tokenAddress ?? "none"}\n`);

  const ctx: AgentContext = {
    candidate: {
      id: "adhoc",
      handle: user.username,
      xUserId: user.id,
      displayName: user.name,
      tokenAddress,
      chain: tokenAddress ? "sol" : null,
    },
    providers,
    xUser: user,
    hints: { websiteUrl: null, githubUrl: null },
    log: (m, meta) => console.log(`[scout] ${m}`, meta ?? ""),
  };

  const { report, scores, errors } = await runGraph(ctx);
  console.log("\n=== SCORES ===");
  console.log(scores);
  if (report.onchain) {
    console.log("\n=== ON-CHAIN ===");
    console.log(report.onchain);
  }
  console.log("\n=== RED FLAGS ===");
  console.log(report.redFlags);
  console.log("\n=== SUMMARY ===");
  console.log(report.summary);
  if (errors.length) {
    console.log("\n=== DEGRADED NODES ===");
    console.log(errors);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
