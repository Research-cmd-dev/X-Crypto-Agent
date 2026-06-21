/**
 * Offline demo of the MIGRATION funnel: poll GMGN for freshly-migrated Solana
 * tokens, link each to its X account, score with the on-chain + social blend, and
 * print the ranking with scam flags.
 *
 *   npm run migration-demo
 *
 * With no GMGN_API_KEY it runs against MockGmgnProvider — no network or keys. The
 * social layer here is illustrative (in production it comes from the X analyzer);
 * the point is to show migration → X-link → blended score → scam flags end-to-end.
 */
import { getGmgnProvider } from "@/lib/providers/gmgn";
import { parseTwitterHandle } from "@/lib/discovery/migration";
import { emptyReport } from "@/lib/orchestrator/graph";
import { buildOnchain, priceFromSummary } from "@/lib/scoring/onchain";
import { runScorer } from "@/lib/agents/scorer";

async function main() {
  const gmgn = getGmgnProvider();
  const live = Boolean(process.env.GMGN_API_KEY);
  const tokens = await gmgn.recentMigrations({ chain: "sol" });

  const rows = [];
  for (const t of tokens) {
    const [security, traders] = await Promise.all([
      gmgn.tokenSecurity(t.address),
      gmgn.topTraders(t.address),
    ]);
    const handle = parseTwitterHandle(t.twitter);
    const report = emptyReport(handle ?? t.symbol);
    report.onchain = buildOnchain(t, security, traders);
    report.price = priceFromSummary(t);
    report.technicalDepth.score = 50;
    report.website.score = 50;
    report.github.score = 50;
    if (handle) {
      // Illustrative social layer — production sources this from the X analyzer.
      report.account.userId = `mock:${handle}`;
      report.account.createdAt = "2024-06-01";
      report.smartMoney.score = 70;
      report.engagement.momentumScore = 65;
      report.profile.followerQuality = { score: 72, notes: "mock" };
    }
    const { scores, redFlags } = runScorer(report);
    rows.push({ t, handle, scores, redFlags });
  }
  rows.sort((a, b) => b.scores.overall - a.scores.overall);

  console.log(`Migration funnel: ${rows.length} graduated token(s) via ${live ? "GMGN API" : "MOCK GMGN"}:\n`);
  for (const { t, handle, scores, redFlags } of rows) {
    console.log(
      `${String(scores.overall).padStart(3)} ${scores.verdict.padEnd(8)} ${(t.symbol || "?").padEnd(7)} ` +
        `X:${(handle ? "@" + handle : "none").padEnd(12)} sm=${scores.smartMoney} early=${scores.earliness} price=${scores.price}`,
    );
    if (redFlags.length) console.log(`     flags: ${redFlags.map((f) => f.code).join(", ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
