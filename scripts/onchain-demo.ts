/**
 * Offline demo of the Solana on-chain funnel: discover trending tokens via GMGN,
 * assemble the on-chain report section, score them, and print the ranking.
 *
 *   npm run onchain-demo
 *
 * With no GMGN_API_KEY it runs against the deterministic MockGmgnProvider, so it
 * needs no network or keys — it proves discovery → on-chain scoring end-to-end.
 * With GMGN_API_KEY set (and gmgn.ai allowlisted) it hits the live API.
 */
import { getGmgnProvider } from "@/lib/providers/gmgn";
import { emptyReport } from "@/lib/orchestrator/graph";
import { buildOnchain, priceFromSummary } from "@/lib/scoring/onchain";
import { computeScores, securityRedFlags, explainScore } from "@/lib/schema/scoring";

async function main() {
  const gmgn = getGmgnProvider();
  const live = Boolean(process.env.GMGN_API_KEY);
  const tokens = await gmgn.trending({ chain: "sol", orderBy: "smart_degen_count", limit: 20 });

  const rows = [];
  for (const t of tokens) {
    // Per-token enrichment (rate-limited live) — only the security + top traders.
    const [security, traders] = await Promise.all([
      gmgn.tokenSecurity(t.address),
      gmgn.topTraders(t.address),
    ]);
    const onchain = buildOnchain(t, security, traders);
    const report = emptyReport(t.symbol || t.address);
    report.onchain = onchain;
    report.price = priceFromSummary(t);
    // Social signals are unmeasured in this funnel → neutral so they don't skew.
    report.website.score = 50;
    report.github.score = 50;
    report.technicalDepth.score = 50;
    report.redFlags = securityRedFlags(onchain);
    const s = computeScores(report);
    rows.push({ t, s, headline: explainScore(report).headline });
  }
  rows.sort((a, b) => b.s.overall - a.s.overall);

  console.log(`Scored ${rows.length} Solana token(s) via ${live ? "GMGN API" : "MOCK GMGN"}:\n`);
  for (const { t, s, headline } of rows) {
    console.log(
      `${String(s.overall).padStart(3)} ${s.verdict.padEnd(8)} ${(t.symbol || "?").padEnd(8)} ` +
        `sm=${s.smartMoney} early=${s.earliness} price=${s.price}  ${t.address.slice(0, 6)}…`,
    );
    console.log(`     ${headline}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
