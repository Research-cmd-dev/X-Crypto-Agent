# Testing & Rapid Iteration Guide — Crypto Scout Swarm

**Goal**: Know the current state instantly and iterate on the system (discovery, agents, prompts, scoring) as fast and cheaply as possible.

### Launch probability feedback loop (pump.fun)

| Step | Command | Keys? |
|------|---------|-------|
| Rank graduates | `npm run rank-launches` | ST |
| Label history | `npm run backfill-outcomes -- 72 --save` | ST + Birdeye |
| Retune weights | `npm run calibrate-launches -- --write` | **none** (uses JSONL or synthetic) |
| Apply | Review `fixtures/outcomes/best-config.json` → edit `DEFAULT_LAUNCH_SCORE` | — |

`calibrate-launches` always works offline with synthetic data so you can verify the loop before keys arrive.

The system was deliberately built with a **fast calibration loop** in mind: expensive LLM research is cached once; everything downstream (scoring, structural flags, assembly) is deterministic and sweepable in <1s with zero extra cost.

---

## 1. Where We Are — Snapshot Commands (30 seconds)

```bash
npm test                  # 25 unit tests (scoring, graph tolerance, extractors)
npm run typecheck         # clean
npm run build             # production build succeeds
git status && git log --oneline -5
ls fixtures/reports       # cached reports + synthetic anchors
```

Current health (as of latest exploration):
- All 25 tests green.
- Clean typecheck + successful build.
- Strong CLI coverage for local dev without Supabase/Trigger:
  - `scout`, `analyze`, `score`, `discover`, `scan`, `migrations`.
- Full persisted pipeline: Supabase + Trigger.dev jobs + dashboard at `/dashboard`.
- Scoring model is fully auditable (no magic in the LLM).

Persistent iteration artifacts:
- `fixtures/reports/*.json` — real runs (`--save`) + `_synthetic-early-gem.json` / `_synthetic-empty-shell.json` (good/bad anchors).
- `fixtures/watchlist.json` — produced by `npm run discover -- --loop N`.

---

## 2. Test Tiers (from fastest/cheapest to slowest)

| Tier | Command(s) | Time | Cost | What it covers | When to use |
|------|------------|------|------|----------------|-------------|
| **Units** | `npm test` / `npm run test:watch` | <10s | $0 | Pure logic: scoring math, red flags + exemptions, extractors, graph assembly + failure tolerance | Always, before any change |
| **Graph smoke** | `npm run scout` | 30-90s | Grok only | Full orchestrator with **MockXProvider** (no X token needed) + real agents | Quick validation that graph wires + merging + scoring still work |
| **Deep + cache** | `npm run analyze -- <handle> [--save]` | 2-4 min | Grok + X | Real X API + full swarm (X → parallel agents) on a live candidate | When changing prompts, agents, extract logic, or X-provider behavior |
| **Zero-cost scoring sweeps** | `npm run score`<br>`RF_HIGH=0 W_ONCHAIN=0.25 npm run score` | <1s | $0 | Deterministic re-score of every cached report with live overrides | **Primary iteration tool** for weights, penalties, thresholds, exempts, sub-score functions |
| **Discovery** | `npm run discover -- --loop 2 --theme ai`<br>`npm run scan`<br>`npm run migrations` | varies | X + Bitquery | Signal sources + cross-join + leaderboards | When improving recall or adding new query vectors |
| **Full system** | Supabase + `npm run seed` + `npm run trigger:dev` + dashboard or `/api/discovery/trigger` | — | all keys | End-to-end scheduled jobs, persistence, UI | Integration / prod-like validation |

**Key enablers**:
- `MockXProvider` (src/lib/providers/x/mock.ts) — deterministic users/tweets/followers.
- `fakeAgents` override pattern in graph tests.
- `makeReport()` (src/lib/schema/fixtures.ts) + `computeScores(..., cfg)`.
- `scripts/score.ts` reads env overrides for every knob in `DEFAULT_SCORING`.

---

## 3. The Killer Loop: Score Everything Instantly

After any analysis report is cached:

```bash
npm run seed:fixtures          # (re)creates the two synthetic anchors
npm run score                  # baseline
```

Sweep examples (no code edits):

```bash
# Remove high penalties entirely for a sweep
RF_HIGH=0 RF_MED=0 RF_CAP=20 npm run score

# Re-weight early traction heavily
W_ONCHAIN=0.30 W_PROFILE=0.15 W_GITHUB=0.10 npm run score

# Make "High" harder to achieve
V_HIGH=75 V_MONITOR=45 npm run score

# Combine
RF_HIGH=8 W_ONCHAIN=0.25 V_HIGH=68 npm run score
```

Output table shows per-component sub-scores + overall + verdict for every fixture. Use this to decide on changes, then implement + re-run.

**Edit source then re-validate** (still fast):
- Edit `src/lib/schema/scoring.ts` (onchainScore, priceContextScore, redFlagPenalty, computeScores, exempt patterns, etc.).
- `npm run score` (or with overrides) to confirm behavior.
- Add a unit test case in `scoring.test.ts`.

---

## 4. Common Improvement Workflows + Verification Checklist

### A. Tune scoring / add sub-score logic
1. Run baseline `npm run seed:fixtures && npm run score`.
2. Propose change (edit weights, onchainScore, new exempt, etc.).
3. `npm run score` (with/without env overrides) — compare tables.
4. Add/update test in `src/lib/schema/scoring.test.ts`.
5. `npm test`.
6. Paste score sweep diff in PR description.

Files: `src/lib/schema/scoring.ts`, `scoring.test.ts`, `scripts/score.ts`.

### B. Change a prompt or LLM behavior (X analyzer, website, etc.)
1. Edit `src/lib/prompts/<name>.system.ts`.
2. Pick a representative handle (one you have cached or will cache): `npm run analyze -- somehandle --save`.
3. Inspect the new report JSON (and `npm run score`).
4. If the change is deterministic downstream (red flags, summary assembly), add a test using `makeReport` + `runScorer`.
5. `npm test`.
6. Re-analyze 1 "gem-like" and 1 "weak" case; note verdict/score movement.

Files: prompts/, agents/x-analyzer.ts (and siblings), graph.ts, schema/analysis.ts.

### C. Add or strengthen a structural red flag
1. Edit `src/lib/agents/scorer.ts` → `deriveStructuralRedFlags`.
2. Use `makeReport({...})` + `runScorer` in a test.
3. Run `npm run score` against cached reports that should now surface the flag.
4. `npm test`.

### D. Improve extraction or deterministic signals
1. Edit `src/lib/extract.ts`.
2. Add cases in `src/lib/extract.test.ts`.
3. `npm test`.
4. Optionally feed a real bio through `npm run analyze` to see it propagate to hints (website/github/CA) in the report.

### E. Add a new agent or data source
1. Implement `Agent` in `src/lib/agents/`.
2. Wire it into `DEFAULT_AGENTS` + parallel call in `src/lib/orchestrator/graph.ts`.
3. Update context/providers if needed.
4. Add a fake version to `fakeAgents` in `graph.test.ts` and assert slice + overall impact.
5. `npm test`.
6. Manual smoke: `npm run scout` or full analyze.

### F. Discovery / signal source changes
- Edit `src/lib/discovery/scan.ts` or `DEFAULT_SOURCES`.
- Or the THEMES in `scripts/discover.ts`.
- Run `npm run discover -- --loop 1` and inspect watchlist leaderboards + new candidates.
- No unit tests today; manual + `npm test` (other code).

---

## 5. Before You Commit / Open a PR

```bash
npm test && npm run typecheck && npm run build
# Run at least one meaningful score sweep with your numbers
npm run seed:fixtures && <YOUR_OVERRIDES> npm run score
# If you touched agents/prompts: re-analyze at least one fixture
npm run analyze -- c0mputeAI --save   # or your handle
```

Document in the PR:
- Unit tests added/updated.
- Score table before/after (or sweep).
- Any real-candidate examples (verdict/overall movement).

---

## 6. Full End-to-End (Supabase + Trigger + UI)

1. Copy `.env.example` → `.env` / `.env.local` and fill required keys.
2. Apply schema: `psql "$SUPABASE_DB_URL" -f supabase/schema.sql`.
3. `npm run seed` (signal sources).
4. `npm run trigger:dev` (in one terminal).
5. `npm run dev` (dashboard).
6. Trigger discovery: dashboard "Run discovery" button or `curl -X POST http://localhost:3000/api/discovery/trigger`.
7. Watch candidates appear and get analyzed. Open `/dashboard/<id>`.

The `analyze-candidate` task has concurrency limit 4 and freshness skip (see src/trigger/analyze-candidate.ts).

---

## 7. Extending Test Coverage

- All pure functions should have unit tests (`scoring.*`, `extract.*`, structural flags, etc.).
- Graph-level tolerance/assembly uses `fakeAgents` overrides — extend this for any new node.
- We intentionally avoid stubbing the LLM (Grok) for most agent tests (too brittle/expensive). Rely on:
  - Cached real reports.
  - `makeReport` + downstream pure logic.
  - `MockXProvider`.
- To add coverage reporting: `npm run test:coverage` (after dev dep is present).

---

## 8. Quick Reference Commands

```bash
# Tests
npm test
npm run test:watch
npm run test:coverage   # if configured

# Fast dev loop
npm run scout
npm run analyze -- <handle|url> [--save]
npm run score
RF_... W_... V_... npm run score
npm run seed:fixtures

# Discovery
npm run discover -- --loop 3
npm run discover -- --theme depin --hours 48
npm run scan
npm run migrations 12

# Infra
npm run typecheck
npm run build
npm run dev
npm run trigger:dev
```

See also the original README for full setup, architecture diagram, and scoring model details.

---

**Philosophy**: Change → unit test + sweep → cheap re-analyze once → ship. The expensive part should only be paid when the research/evidence-gathering actually changes.
