/**
 * Standalone discovery scan — scan X (recent search) for fresh crypto-project
 * accounts, enrich each hit's profile, and rank by early-stage signal (new
 * account + contract address + some traction). No Supabase / Trigger.dev.
 *
 *   npm run scan                     # default early-AI/pump.fun queries
 *   npm run scan -- "your X query"   # one custom recent-search query
 *
 * Requires X_API_BEARER_TOKEN (paid X API plan with recent search). Pipe a hit
 * into the full swarm with:  npm run analyze -- <handle>
 */
import { XApiProvider, type XUser } from "@/lib/providers/x";
import { scanSignalSources, DEFAULT_SOURCES, type SignalSource } from "@/lib/discovery/scan";
import { extractContractAddress, extractUrls, firstWebsiteUrl } from "@/lib/extract";

const ENRICH_CAP = 30;

interface Hit {
  handle: string;
  followers: number;
  following: number;
  ageDays: number | null;
  contract: string | null;
  website: string | null;
  note: string;
  interest: number;
}

function ageDays(createdAt: string | null): number | null {
  if (!createdAt) return null;
  const ms = Date.now() - new Date(createdAt).getTime();
  return Number.isNaN(ms) ? null : Math.round(ms / 86_400_000);
}

/** Lightweight pre-analysis interest heuristic (NOT the full scoring model). */
function interestScore(u: XUser, contract: string | null, website: string | null, age: number | null): number {
  let s = 0;
  if (contract) s += 50; // has a live token
  if (website) s += 10;
  if (age != null && age <= 90) s += 20;
  else if (age != null && age <= 180) s += 8;
  if (u.followersCount >= 200 && u.followersCount <= 200_000) s += 15;
  if (u.followersCount >= 1000) s += 5;
  return s;
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);

async function main() {
  const custom = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!process.env.X_API_BEARER_TOKEN) {
    console.error("Set X_API_BEARER_TOKEN — the scan hits the real X recent-search API.");
    process.exit(1);
  }
  // serverEnv() (via XApiProvider) validates Supabase vars; the scan never persists.
  process.env.SUPABASE_URL ??= "https://mock.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "mock";

  const x = new XApiProvider();
  const sources: SignalSource[] = custom
    ? [{ id: "custom", kind: "query", value: custom }]
    : DEFAULT_SOURCES;

  console.log(`\n🛰  Scanning X across ${sources.length} source(s)…`);
  for (const s of sources) console.log(`   • ${s.value.slice(0, 90)}`);

  const found = await scanSignalSources(x, sources, {
    perSource: 25,
    log: (m, meta) => console.log(`[scan] ${m}`, meta ?? ""),
  });
  console.log(`\nFound ${found.length} distinct account(s). Enriching up to ${ENRICH_CAP}…`);
  if (found.length === 0) {
    console.log("No hits. (If every source failed above, recent search may not be enabled on this X API plan.)");
    return;
  }

  const hits: Hit[] = [];
  await Promise.all(
    found.slice(0, ENRICH_CAP).map(async (c) => {
      const u = await x.getUserById(c.xUserId).catch(() => null);
      if (!u) return;
      const contract = extractContractAddress(`${u.description ?? ""}\n${c.note}`);
      const website = firstWebsiteUrl([...u.urls, ...extractUrls(u.description ?? "")]);
      const age = ageDays(u.createdAt);
      hits.push({
        handle: u.username,
        followers: u.followersCount,
        following: u.followingCount,
        ageDays: age,
        contract,
        website,
        note: c.note,
        interest: interestScore(u, contract, website, age),
      });
    }),
  );

  hits.sort((a, b) => b.interest - a.interest);

  console.log();
  console.log(`  ${pad("handle", 20)}${pad("followers", 11)}${pad("age(d)", 8)}${pad("CA?", 5)}${pad("site?", 7)}${pad("score", 7)}`);
  console.log(`  ${"-".repeat(70)}`);
  for (const h of hits) {
    console.log(
      `  ${pad("@" + h.handle, 20)}${pad(h.followers.toLocaleString(), 11)}${pad(h.ageDays ?? "?", 8)}${pad(h.contract ? "yes" : "-", 5)}${pad(h.website ? "yes" : "-", 7)}${pad(h.interest, 7)}${h.interest >= 50 ? " 🔥" : ""}`,
    );
  }

  const promising = hits.filter((h) => h.interest >= 50);
  console.log(`\n${promising.length} promising hit(s) (has a live token + early signal).`);
  if (promising.length) {
    const top = promising[0];
    console.log(`Top: @${top.handle}${top.contract ? `  CA ${top.contract.slice(0, 6)}…${top.contract.slice(-4)}` : ""}`);
    console.log(`Run the full swarm on it:  npm run analyze -- ${top.handle}`);
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
