# Crypto Scout Swarm

An autonomous system that **scans X (Twitter) for new crypto projects, runs deep
multi-agent research, scores + flags them, stores everything in Supabase, and
surfaces it in a review dashboard.**

- **Discovery** — scheduled jobs + CLI tools scan two vectors:
  - X (curated accounts + search queries) for promising handles (pre- or post-token).
  - pump.fun migrations (on-chain graduations) for newly live tokens.
  Results feed the multi-agent analyzer + scoring. (Cadence configurable; current default 6h for Trigger.)
- **Deep research** — a multi-agent "swarm" (the `x-account-crypto-analyzer`
  skill + website, GitHub, and price agents) investigates each candidate using
  the X API, GitHub, price feeds, and Claude's web search/fetch tools.
- **Scoring** — a deterministic, auditable model combines sub-scores into an
  overall score and a verdict: **High / Monitor / Avoid**.
- **Dashboard** — a Next.js UI to triage candidates, filter by verdict, and read
  the full report.

---

## Architecture

```
                  ┌──────────────────── Trigger.dev ────────────────────┐
  signal_sources  │  discovery (cron + manual)                          │
        │         │     • X: queries + curated accounts (30min)          │
        │         │     • pump.fun migrations (30min) → token-first + X  │
        ▼         │     dedupe → insert candidates → fan out ↓           │
   candidates ───▶│  analyze-candidate (per candidate, concurrency-cap)  │
                  │     └─▶ orchestrator graph                           │
                  └──────────────────────┬──────────────────────────────┘
                                         ▼
   ┌─────────────────── orchestrator (LangGraph-style) ───────────────────┐
   │  X Analyzer ──▶ ( Website ∥ GitHub ∥ Price ∥ Onchain ) ──▶ Scorer ──▶ persist │
   │  (supports X-first or migration/token-first candidates)                         │
   │  (each node failure-tolerant; partial failures degrade, never abort)  │
   └──────────────────────────────────────────────────────────────────────┘
                                         ▼
        analysis_reports · scores · flags  ──▶  Dashboard (/dashboard)
```

- **Agents** call **Grok** (xAI, e.g. `grok-4.3`) in two phases: research with the
  built-in `web_search` server tool (real-time web + browsing), then a
  structured-output synthesis validated by Zod (via function calling). Hard
  numbers (followers, stars, market cap, on-chain) come from the X API / GitHub
  / price feeds / Bitquery and are merged over the model's qualitative output.
- The **`AnalysisReport` Zod schema** (`src/lib/schema/analysis.ts`) is the single
  source of truth — reused for runtime validation, the LLM's structured output,
  and TypeScript types.

### Tech stack

Next.js 15 (App Router) · TypeScript · Tailwind + shadcn/ui · Zod · Supabase
(Postgres) · Trigger.dev v3 · `openai` (for xAI/Grok) · `@octokit/rest`.

### Project layout

```
src/
  app/            dashboard pages + API routes
  components/     shadcn UI + table / detail / score / verdict components
  lib/
    schema/       AnalysisReport Zod schema + scoring model
    providers/    x (API v2 + mock), github (Octokit), price (Birdeye/DexScreener), solanatracker (on-chain/migrations), bitquery (legacy), gmgn (smart money/risk via Agent API)
    llm/          Grok/xAI client (openai sdk), researchText with web_search tool, parseStructured via function calls
    agents/       x-analyzer, website, github, price, onchain, scorer
    orchestrator/ graph (nodes), persist, analyzeCandidate entrypoint
    data/         dashboard data-access
  trigger/        discovery + analyze-candidate jobs
supabase/schema.sql
scripts/          seed signal sources, mock dev runner
```

---

## Prerequisites

- **Node 20+**
- A **Supabase** project (Postgres)
- An **xAI API key** (`XAI_API_KEY`, required) — get one at console.x.ai
- An **X API v2 Bearer token** (required — a paid X API plan)
- A **Trigger.dev** account/project (to run the jobs)
- Optional: **GitHub token** (higher rate limits), **Birdeye API key** (early/
  pump.fun token market data by contract address; CoinGecko is not used)

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env.local   # for Next.js
cp .env.example .env         # for scripts + Trigger.dev
```

Fill in the values (see `.env.example` for the full list). Minimum to run the
pipeline: `XAI_API_KEY`, `X_API_BEARER_TOKEN`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, and the Trigger.dev keys.

### 3. Apply the database schema

In the Supabase SQL editor (or `psql`), run:

```bash
psql "$SUPABASE_DB_URL" -f supabase/schema.sql
```

This creates the enums, tables (`signal_sources`, `candidates`,
`analysis_reports`, `scores`, `flags`), indexes, and the
`latest_candidate_scores` view. It is idempotent.

### 4. Seed signal sources

```bash
npm run seed
```

Edit `scripts/seed-signal-sources.ts` to set your own curated accounts + search
queries.

### 5. Run Trigger.dev (jobs)

```bash
npm run trigger:dev      # local dev worker
# or: npm run trigger:deploy
```

### 6. Run the dashboard

```bash
npm run dev
# open http://localhost:3000/dashboard
```

### 7. Kick off discovery

- Click **Run discovery** in the dashboard, or
- `curl -X POST http://localhost:3000/api/discovery/trigger`, or
- wait for the schedule (X every 30min + pump.fun migrations every 30min; see `src/trigger/discovery.ts`).

**Dual automatic discovery** (designed for the goal of frequent scans):
- X side: scans queries + curated accounts every 30min.
- Migration side: scans recent pump.fun graduations every 30min → resolves linked X (when available) or creates token-first candidate → full agent analysis (X + website + GitHub + on-chain) + scoring/rating.

Both paths feed the same `analyze-candidate` queue + persist + dashboard. Use CLI tools (`npm run discover`, `npm run migrations`) for ad-hoc or local loops.

Discovery inserts candidates and fans out analysis jobs; results appear in the
dashboard as each candidate is analyzed. The analyzer (X + website + GitHub + on-chain)
+ deterministic scorer produces the rating (High/Monitor/Avoid).

---

## Scoring model

`src/lib/schema/scoring.ts` — deterministic and auditable:

```
overall = 0.20·profile + 0.10·website + 0.15·github + 0.15·engagement
        + 0.10·technicalDepth + 0.10·price + 0.20·onchain
        − redFlagPenalty            (floored at 0)

verdict = overall ≥ 70 → High | ≥ 40 → Monitor | else Avoid
```

**Sub-scores** (each 0–100, clamped): `profile` = follower quality, `website`,
`github`, `engagement` = momentum, `technicalDepth`, `price` = liquidity context,
`onchain` = early traction (holders + 24h active traders/trades, from Bitquery).
Weights lean toward early-stage substance + on-chain traction.

**Red-flag penalty.** `redFlagPenalty` (per-severity weights high −12 / med −5 /
low −2) is intentionally **not** a raw sum: flags apply strongest-first with
diminishing returns (`RED_FLAG_DECAY`) and the total is capped
(`MAX_RED_FLAG_PENALTY`), so a pile of model-emitted flags can't auto-fail an
otherwise strong project. The goal is **super-early projects that could be real**,
so normal early-stage traits carry **zero penalty** — `PENALTY_EXEMPT_PATTERNS`
exempts pump.fun / bonding-curve launches and anonymous / pseudonymous teams
(having any real dev or code at all is a positive). Penalties are reserved for
genuine low-legitimacy signals (no code, plagiarism, fake partnerships, honeypots,
bot-only engagement).

Every knob lives in `DEFAULT_SCORING` (`ScoringConfig`) and `computeScores`
accepts a config override, so calibration can be swept without editing source.

### Calibrating fast (no API calls)

The expensive part (research + synthesis) is cached once (`npm run analyze -- <h> --save`); scoring + structural rules are then instant and fully sweepable:

```bash
npm run seed:fixtures
npm run score
# live overrides (no edits):
RF_HIGH=0 W_ONCHAIN=0.25 V_HIGH=68 npm run score
```

See the full guide (tiers, workflows, checklists, examples) in [docs/TESTING.md](docs/TESTING.md).

---

## Discovery & analysis from the CLI

The whole pipeline runs standalone (no Supabase / Trigger.dev):

| Command | What it does |
|---|---|
| `npm run scan [-- "<query>"]` | Scan X recent-search for fresh project accounts; rank by early-stage signal |
| `npm run migrations [-- <hours>]` | pump.fun graduations ranked by **launchScore** (no LLM) |
| `npm run rank-launches [-- <hours>]` | Same funnel as production: feature pack → score → top-K shortlist |
| `npm run watch-migrations` | Real-time WS watcher for graduated tokens (Solana Tracker Datastream) |
| `npm run watch-gmgn` | Real-time WS watcher for GMGN new pools, launches, smart money trades |
| `npm run discover [-- --hours N]` | **Combine both vectors** (see below) |
| `npm run analyze -- <handle\|url>` | Deep multi-agent research — use only on launchScore shortlist |
| `npm run score` | Re-score cached reports instantly (calibration loop) |

**Launch probability funnel** (primary mission — pump.fun graduates):

1. Ingest graduations (Solana Tracker; Bitquery fallback).
2. Cheap feature pack: holders/liq/mcap/volume (+ optional GMGN risk/smart-money).
3. Deterministic `computeLaunchScore` in `src/lib/schema/launch-score.ts` (vetoes + 0–100 rank).
4. Only **top-K** survivors get full multi-agent analysis (cost control).

GMGN is optional enrichment — swap or omit without breaking the scorer. Primary path is ST + price feeds.

`discover` joins the two searches on the **X-handle ↔ contract-address** link: an X
hit's bio yields its contract address (→ on-chain traction), and a migrated token's
metadata yields its X handle (→ social profile). Every candidate then carries *both*
dimensions. Those strong on both rank highest (🔗 confirmed by both searches); on-chain
traction with little social presence is flagged (⚠) as a likely bot/pump.

## Testing & verification

```bash
npm test            # vitest (25 tests: scoring, graph tolerance, extractors)
npm run typecheck
npm run build
```

See the complete practical guide — current state, 4 test tiers, zero-cost scoring sweeps, common improvement workflows, and checklists — in **[docs/TESTING.md](docs/TESTING.md)**.

Quick smoke (Mock X + real Grok, needs `XAI_API_KEY`):

```bash
npm run scout
```

Full real analysis + cache for the fast scoring loop:

```bash
npm run analyze -- <handle | x.com URL> [--save]
```

---

## Extending

- **Add a signal source** — insert into `signal_sources` (or edit the seed).
- **Add an agent** — implement the `Agent` interface (`src/lib/agents/types.ts`)
  and add it to the graph in `src/lib/orchestrator/graph.ts`. Nodes are
  failure-tolerant by construction.
- **Swap a data provider** — the X provider sits behind the `XProvider`
  interface (`src/lib/providers/x`), so the real API v2 client can be replaced
  with `MockXProvider` (used in tests) or another source.
- **GMGN integration** — use the GMGN Agent API (docs at https://docs.gmgn.ai/index/gmgn-agent-api).
  Install skills: `npx skills add GMGNAI/gmgn-skills`. Get API key by uploading pubkey at gmgn.ai/ai.
  Enhances smart money, risk, holders, new token signals (complements SolanaTracker).
- **Adjust the report shape** — extend the Zod schema in
  `src/lib/schema/analysis.ts`; types, validation, and LLM output update together.

---

## Notes

- **LLM provider:** switched to xAI Grok via the OpenAI-compatible SDK
  (`https://api.x.ai/v1`). Grok uses the Responses API for built-in `web_search`
  (real-time research + browsing) and function calling for structured synthesis.
  Set `XAI_API_KEY` and optionally `GROK_MODEL` (default `grok-4.3`).
- **Cost control (key for production):** 
  - Research + X data heavily cached (in-memory, short TTL) — avoids repeats.
  - Pre-filters + early cheap triage (onchain/profile) before expensive Grok calls; skip web enrichment for weak signals.
  - Reduced data volumes (samples, maxUses, tokens) and longer freshness (12h default).
  - Cheaper default `GROK_MODEL` (grok-3); override per need. Deterministic agents (onchain/price) avoid LLM.
  - In-graph early exits and profile-based skips.
  Use `npm run score` (env overrides) for free tuning. Monitor `approx_llm_calls` in logs.
  X MCP (hosted) recommended for dev (Cursor/Grok Build) — gives native X tools to the model with minimal setup.
- **Compliance:** respect the X API terms and rate limits. The X client
  implements the happy path; add backoff/pagination for production volume.
