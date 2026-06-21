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
   │  X Analyzer ──▶ ( Website ∥ GitHub ∥ Price ) ──▶ Scorer ──▶ persist   │
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
    providers/    x (API v2 + mock), github (Octokit), price (CoinGecko/DexScreener)
    anthropic/    client, structured-output parse, web-tool research loop
    agents/       x-analyzer, website, github, price, scorer
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
- Optional: **GitHub token** (higher rate limits), **CoinGecko Pro key**

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
overall = 0.25·profile + 0.20·website + 0.20·github
        + 0.15·engagement + 0.10·technicalDepth + 0.10·price
        − redFlagPenalty            (high −15 / med −7 / low −3, floored at 0)

verdict = overall ≥ 70 → High | ≥ 40 → Monitor | else Avoid
```

The price/liquidity sub-score is derived from 24h-volume-to-market-cap
(pre-token projects are treated as neutral). Tune the weights/thresholds in one
place.

---

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
