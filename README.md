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

## Alpha thesis

The system is tuned to find **low-float early gems that smart money is piling
into before the crowd.** That thesis drives the scoring weights and the seed
signal accounts — it is the thing to change if your edge is different.

- **Smart money is weighted highest** — a tiny project already followed/engaged
  by reputable funds, known builders, or sharp traders is the strongest signal.
- **Earliness / low float** rewards young-but-established accounts, small-but-real
  followings, and microcap / pre-token stage (the timing edge).
- **Engagement momentum** (incl. engagement rate — high engagement on a *small*
  account = a real, sticky community) is a leading indicator.
- **Website / GitHub** carry less *positive* weight (early gems rarely have mature
  sites/repos) but still feed **red flags** as a scam/credibility check.
- **Red flags stay harsh** so the "High" list stays scam-free — critical for
  microcaps.

## Scoring model

`src/lib/schema/scoring.ts` — deterministic and auditable. Active profile
`ALPHA_WEIGHTS` (sums to 1.0):

```
overall = 0.28·smartMoney + 0.18·engagement + 0.15·earliness + 0.12·profile
        + 0.10·technicalDepth + 0.07·website + 0.06·github + 0.04·price
        − redFlagPenalty            (high −15 / med −7 / low −3, floored at 0)

verdict = overall ≥ 70 → High | ≥ 40 → Monitor | else Avoid
```

- `earlinessScore(report)` — deterministic from account age + follower band +
  market-cap band.
- `explainScore(report)` — the "why this score" breakdown rendered on the detail
  page (per-signal point contributions + red-flag penalties + a headline).
- **Tune the thesis** by editing `ALPHA_WEIGHTS` / `VERDICT_THRESHOLDS` in one
  place; `explainScore` and the dashboard update automatically.

---

## Backtesting & weight tuning

Weights live in the DB (`weight_versions`, one active row) so they can be tuned
without a redeploy. Every scored token seeds an `outcomes` row (entry price
frozen at scoring time); the scheduled `outcomes` job fills in the forward return
and freezes it after 30 days. `npm run backtest` then measures how well the score
ranked realized returns (Spearman) and proposes better weights
(`src/lib/scoring/backtest.ts`); `--write` saves an inactive `weight_versions`
candidate for review.

**Live, full-fidelity labels take ~30 days to mature.** To get history *now*,
build a **price/fundamentals historical set** from a curated project list:

```bash
cp data/historical-projects.example.json data/historical-projects.json
# edit: [{ "handle", "coingeckoId"?, "token"?, "entryDate": "YYYY-MM-DD", "horizonDays"? }]
npm run backfill -- --dry-run      # fetch + print prices/returns, no DB writes
npm run backfill                   # write matured dataset='historical' outcomes
npm run backtest -- --historical   # per-signal predictive power + measured-only tuning
```

This reconstructs only the **time-travelable** signals — price/market-cap (via
CoinGecko history) and account age (immutable `created_at`). The X social graph
is **not** reconstructable for a past date, so smart money / engagement /
follower quality are left neutral and *not* tuned by the historical set (tuning
is restricted to `MEASURED_SIGNALS`, so those weights are preserved). Free-tier
CoinGecko limits history to ~365 days; keep entry dates within the last year, and
include projects that *failed* (not just winners) to avoid survivorship bias.

---

## Caching & rate limiting

`src/lib/cache/store.ts` + `src/lib/util/fetch.ts`:

- **Shared TTL cache** (`provider_cache` table) wraps X profile lookups (1h),
  GitHub metrics (1h), and price lookups (5m), so repeat lookups across
  Trigger.dev job runs don't re-hit rate-limited APIs. `cached()` **fails open** —
  if the cache is unavailable it just calls through.
- **Backoff** — `fetchWithRetry` retries 429/5xx honoring `retry-after`;
  `mapLimit` bounds discovery's handle-resolution concurrency.
- **Anthropic prompt caching** — `cache_control` on the stable agent system
  prompts cuts repeated-call cost.

---

## Testing & verification

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (scoring, cache, orchestrator partial-failure)
npm run build       # production Next.js build
```

Quick end-to-end smoke test of the agent graph against **mock X data** (still
calls Claude, so needs `ANTHROPIC_API_KEY`; does not touch Supabase):

```bash
npm run scout
```

---

## Extending

- **Add a signal account** — add an `account`/`query` entry to
  `scripts/seed-signal-sources.ts` (or insert into `signal_sources`). Curated
  smart-money accounts are the primary alpha funnel — their @mentions surface
  gems early.
- **Tune scoring** — edit the active profile via `weight_versions` (or
  `ALPHA_WEIGHTS` / `VERDICT_THRESHOLDS` / `earlinessScore` in
  `src/lib/schema/scoring.ts` for the built-in default).
- **Build a historical backtest set** — curate `data/historical-projects.json`
  and run `npm run backfill` (see *Backtesting & weight tuning*).
- **Add an agent** — implement the `Agent` interface (`src/lib/agents/types.ts`)
  and add it to the graph in `src/lib/orchestrator/graph.ts`. Nodes are
  failure-tolerant by construction.
- **Add a cached provider call** — wrap it in `cached(namespace, id, ttlSec, fn)`
  from `src/lib/cache/store.ts`.
- **Swap a data provider** — the X provider sits behind the `XProvider`
  interface (`src/lib/providers/x`); the real API v2 client can be replaced with
  `MockXProvider` (tests) or another source.
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
