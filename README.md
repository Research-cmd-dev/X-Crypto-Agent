# Crypto Scout Swarm

An autonomous system that **scans X (Twitter) for new crypto projects, runs deep
multi-agent research, scores + flags them, stores everything in Supabase, and
surfaces it in a review dashboard.**

- **Discovery** — a scheduled job scans curated signal accounts + broad search
  queries on X for new project accounts.
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
        │         │     scan X (queries + curated-account mentions)      │
        ▼         │     dedupe → insert candidates → fan out ↓           │
   candidates ───▶│  analyze-candidate (per candidate, concurrency-cap)  │
                  │     └─▶ orchestrator graph                           │
                  └──────────────────────┬──────────────────────────────┘
                                         ▼
   ┌─────────────────── orchestrator (LangGraph-style) ───────────────────┐
   │  X Analyzer ──▶ ( Website ∥ GitHub ∥ Price ∥ Onchain ) ──▶ Scorer ──▶ persist │
   │  (each node failure-tolerant; partial failures degrade, never abort)  │
   └──────────────────────────────────────────────────────────────────────┘
                                         ▼
        analysis_reports · scores · flags  ──▶  Dashboard (/dashboard)
```

- **Agents** call **Claude** (`claude-opus-4-8`) in two phases: research with the
  `web_search` / `web_fetch` server tools, then a structured-output synthesis
  validated by Zod. Hard numbers (followers, stars, market cap) come from the X
  API / GitHub / price feeds and are merged over the model's qualitative output.
- The **`AnalysisReport` Zod schema** (`src/lib/schema/analysis.ts`) is the single
  source of truth — reused for runtime validation, the LLM's structured output,
  and TypeScript types.

### Tech stack

Next.js 15 (App Router) · TypeScript · Tailwind + shadcn/ui · Zod · Supabase
(Postgres) · Trigger.dev v3 · `@anthropic-ai/sdk` · `@octokit/rest`.

### Project layout

```
src/
  app/            dashboard pages + API routes
  components/     shadcn UI + table / detail / score / verdict components
  lib/
    schema/       AnalysisReport Zod schema + scoring model
    providers/    x (API v2 + mock), github (Octokit), price (Birdeye/DexScreener, by contract address), bitquery + gmgn (on-chain)
    anthropic/    client, structured-output parse, web-tool research loop
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
- An **Anthropic API key** (required)
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
pipeline: `ANTHROPIC_API_KEY`, `X_API_BEARER_TOKEN`, `SUPABASE_URL`,
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
- wait for the schedule (every 6 hours).

Discovery inserts candidates and fans out analysis jobs; results appear in the
dashboard as each candidate is analyzed.

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

The expensive part (research + synthesis) is cached once; scoring is then instant:

```bash
npm run analyze -- c0mputeAI --save   # run the swarm once, cache the report (~2-3 min)
npm run seed:fixtures                 # add synthetic good/bad anchor reports
npm run score                         # re-score every cached report in ~0.5s

# sweep variables instantly via env overrides — no edits, no API calls:
RF_HIGH=0 RF_CAP=20 npm run score
W_GITHUB=0.30 W_TECH=0.20 W_PROFILE=0.10 npm run score
V_MONITOR=55 npm run score
```

Cached reports live in `fixtures/reports/*.json`. Overrides: weights
`W_PROFILE W_WEBSITE W_GITHUB W_ENGAGEMENT W_TECH W_PRICE W_ONCHAIN`, penalties
`RF_HIGH RF_MED RF_LOW`, `RF_DECAY`, `RF_CAP`, thresholds `V_HIGH V_MONITOR`.

---

## Discovery & analysis from the CLI

The whole pipeline runs standalone (no Supabase / Trigger.dev):

| Command | What it does |
|---|---|
| `npm run scan [-- "<query>"]` | Scan X recent-search for fresh project accounts; rank by early-stage signal |
| `npm run migrations [-- <hours>]` | pump.fun graduations (on-chain), enriched with holders/traders + the token's Twitter |
| `npm run discover [-- --hours N]` | **Combine both vectors** (see below) |
| `npm run analyze -- <handle\|url>` | Deep multi-agent + on-chain research on one account |
| `npm run score` | Re-score cached reports instantly (calibration loop) |

`discover` joins the two searches on the **X-handle ↔ contract-address** link: an X
hit's bio yields its contract address (→ on-chain traction), and a migrated token's
metadata yields its X handle (→ social profile). Every candidate then carries *both*
dimensions. Those strong on both rank highest (🔗 confirmed by both searches); on-chain
traction with little social presence is flagged (⚠) as a likely bot/pump.

## Testing & verification

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (scoring + orchestrator partial-failure tolerance)
npm run build       # production Next.js build
```

Quick end-to-end smoke test of the agent graph against **mock X data** (still
calls Claude, so needs `ANTHROPIC_API_KEY`; does not touch Supabase):

```bash
npm run scout
```

Run the full swarm against one **real** X account (no Supabase), and optionally
cache it for the scoring loop:

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
- **Adjust the report shape** — extend the Zod schema in
  `src/lib/schema/analysis.ts`; types, validation, and LLM output update together.

---

## Notes

- **SDK version:** built against `@anthropic-ai/sdk` 0.70.x, where structured
  outputs and web tools live under `client.beta.messages`. Structured output uses
  `betaZodOutputFormat` (which requires **Zod 4**) + `messages.parse`. Web
  research uses `web_search_20250305` / `web_fetch_20250910`.
- **Cost:** each candidate triggers several Claude calls with web search. Use the
  `analyze-candidate` queue concurrency limit and discovery cadence to control
  spend. `CLAUDE_MODEL` can be pointed at a cheaper model if desired.
- **Compliance:** respect the X API terms and rate limits. The X client
  implements the happy path; add backoff/pagination for production volume.
