/**
 * Seed synthetic anchor reports into fixtures/reports/ so the scoring loop
 * (`npm run score`) always has contrast cases — a real-but-early "gem" and an
 * "empty shell" scam — to check the calibration separates good from bad without
 * needing live API calls. Real accounts are added via `npm run analyze -- <h> --save`.
 *
 *   npm run seed:fixtures
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { makeReport } from "@/lib/schema/fixtures";
import type { AnalysisReport } from "@/lib/schema/analysis";

const dir = path.resolve("fixtures/reports");
mkdirSync(dir, { recursive: true });

function save(name: string, report: AnalysisReport) {
  writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(report, null, 2));
  console.log("seeded", name);
}

// Real-but-early gem: anonymous solo dev + pump.fun launch (both must be
// exempt from penalty), but genuine open-source substance. Should NOT be Avoid.
save(
  "_synthetic-early-gem",
  makeReport({
    account: { handle: "_synthetic-early-gem", displayName: "Early Gem" },
    profile: { followerQuality: { score: 55, notes: "Mostly small but organic followers." } },
    website: { url: "https://gem.example", detected: true, score: 66 },
    github: { url: "https://github.com/anon/gem", detected: true, score: 76, stars: 40, recentCommits: 60, contributors: 1 },
    engagement: { momentumScore: 60 },
    technicalDepth: { score: 80, notes: "Real, reproducible open-source engine." },
    price: { token: "GEM", marketCapUsd: 7_000_000, volume24hUsd: 4_500_000, priceUsd: 0.007, source: "birdeye", notes: "Healthy liquidity." },
    redFlags: [
      { severity: "high", code: "pump_fun_token", message: "Bio CA ends in 'pump' (pump.fun launch)." },
      { severity: "high", code: "anonymous_team", message: "Pseudonymous solo developer." },
      { severity: "med", code: "marketing_ahead_of_product", message: "Token marketing slightly ahead of the product." },
    ],
  }),
);

// Empty shell: genuine scam/low-legitimacy signals only. Should be Avoid.
save(
  "_synthetic-empty-shell",
  makeReport({
    account: { handle: "_synthetic-empty-shell", displayName: "Empty Shell" },
    profile: { followerQuality: { score: 12, notes: "Bot-like, purchased-looking followers." } },
    website: { url: null, detected: false, score: 8 },
    github: { url: null, detected: false, score: 0 },
    engagement: { momentumScore: 18 },
    technicalDepth: { score: 8, notes: "Pure hype, no technical substance." },
    price: { token: "SHELL", marketCapUsd: 30_000_000, volume24hUsd: 5_000, priceUsd: 0.03, source: "dexscreener", notes: "Almost no liquidity." },
    redFlags: [
      { severity: "high", code: "no_code", message: "No repository or product behind grand AI claims." },
      { severity: "high", code: "fake_partnership", message: "Fabricated partnership with a major lab." },
      { severity: "med", code: "bot_engagement", message: "Engagement is bot-driven, no organic substance." },
    ],
  }),
);
