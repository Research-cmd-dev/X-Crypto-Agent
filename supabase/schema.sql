-- ============================================================================
-- crypto-scout-swarm — Supabase / Postgres schema
-- Apply via: Supabase SQL editor, or `psql "$DATABASE_URL" -f supabase/schema.sql`
-- Safe to re-run (idempotent): uses IF NOT EXISTS / DO $$ guards.
-- ============================================================================

-- ---- Enums -----------------------------------------------------------------
do $$ begin
  create type signal_source_kind as enum ('account', 'query');
exception when duplicate_object then null; end $$;

do $$ begin
  create type candidate_status as enum (
    'discovered', 'queued', 'analyzing', 'analyzed', 'failed'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type verdict as enum ('High', 'Monitor', 'Avoid');
exception when duplicate_object then null; end $$;

do $$ begin
  create type flag_severity as enum ('low', 'med', 'high');
exception when duplicate_object then null; end $$;

-- ---- updated_at trigger helper ---------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ---- signal_sources --------------------------------------------------------
-- Curated accounts + search queries the discovery job scans.
create table if not exists signal_sources (
  id          uuid primary key default gen_random_uuid(),
  kind        signal_source_kind not null,
  value       text not null,                 -- handle (without @) or search query
  label       text,
  weight      real not null default 1.0,     -- influences discovery prioritization
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (kind, value)
);

drop trigger if exists trg_signal_sources_updated_at on signal_sources;
create trigger trg_signal_sources_updated_at
  before update on signal_sources
  for each row execute function set_updated_at();

-- ---- candidates ------------------------------------------------------------
-- Discovered projects/accounts awaiting (or having completed) analysis.
create table if not exists candidates (
  id             uuid primary key default gen_random_uuid(),
  x_user_id      text not null,              -- X numeric user id (stable)
  handle         text not null,              -- X handle without @
  display_name   text,
  source_id      uuid references signal_sources(id) on delete set null,
  discovery_note text,                       -- e.g. the tweet/query that surfaced it
  status         candidate_status not null default 'discovered',
  discovered_at  timestamptz not null default now(),
  analyzed_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (x_user_id)
);

drop trigger if exists trg_candidates_updated_at on candidates;
create trigger trg_candidates_updated_at
  before update on candidates
  for each row execute function set_updated_at();

create index if not exists idx_candidates_status on candidates(status);
create index if not exists idx_candidates_discovered_at on candidates(discovered_at desc);
create index if not exists idx_candidates_source on candidates(source_id);

-- ---- analysis_reports ------------------------------------------------------
-- Full structured AnalysisReport JSON per analysis run (validated by Zod).
create table if not exists analysis_reports (
  id            uuid primary key default gen_random_uuid(),
  candidate_id  uuid not null references candidates(id) on delete cascade,
  model         text not null,
  payload       jsonb not null,             -- validated AnalysisReport
  created_at    timestamptz not null default now()
);

create index if not exists idx_reports_candidate on analysis_reports(candidate_id);
create index if not exists idx_reports_created_at on analysis_reports(created_at desc);

-- ---- scores ----------------------------------------------------------------
-- Numeric sub-scores + overall + verdict for a given report.
create table if not exists scores (
  id              uuid primary key default gen_random_uuid(),
  candidate_id    uuid not null references candidates(id) on delete cascade,
  report_id       uuid not null references analysis_reports(id) on delete cascade,
  smart_money     integer not null default 0,
  earliness       integer not null default 0,
  profile         integer not null default 0,
  website         integer not null default 0,
  github          integer not null default 0,
  engagement      integer not null default 0,
  technical_depth integer not null default 0,
  price           integer not null default 0,
  overall         integer not null default 0,
  verdict         verdict not null,
  created_at      timestamptz not null default now()
);

-- Additive migration for existing databases (no-op on fresh installs).
alter table scores add column if not exists smart_money integer not null default 0;
alter table scores add column if not exists earliness integer not null default 0;
-- weight_version_id is added (with its FK) after weight_versions is defined below.

create index if not exists idx_scores_candidate on scores(candidate_id);
create index if not exists idx_scores_report on scores(report_id);
create index if not exists idx_scores_verdict on scores(verdict);
create index if not exists idx_scores_overall on scores(overall desc);

-- ---- weight_versions -------------------------------------------------------
-- Versioned, tunable scoring profiles (weights + thresholds + penalties) so
-- weights can change without a code deploy and be refined by backtesting.
-- Exactly one row is active at a time (enforced by the partial unique index).
create table if not exists weight_versions (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  profile     jsonb not null,                  -- { weights, thresholds, penalties }
  active      boolean not null default false,
  source      text not null default 'manual',  -- 'manual' | 'backtest'
  metrics     jsonb,                            -- backtest fitness when source='backtest'
  created_at  timestamptz not null default now()
);

create unique index if not exists weight_versions_one_active
  on weight_versions(active) where active;

-- Every score records which profile produced it (drift-free reconstruction).
alter table scores
  add column if not exists weight_version_id uuid references weight_versions(id);

-- Seed the built-in baseline profile (mirrors ALPHA_WEIGHTS in src/lib/schema/scoring.ts).
insert into weight_versions (label, profile, active, source)
select
  'baseline',
  '{
    "weights": {
      "smartMoney": 0.28, "engagement": 0.18, "earliness": 0.15, "profile": 0.12,
      "technicalDepth": 0.10, "website": 0.07, "github": 0.06, "price": 0.04
    },
    "thresholds": { "high": 70, "monitor": 40 },
    "penalties": { "high": 15, "med": 7, "low": 3 }
  }'::jsonb,
  true,
  'manual'
where not exists (select 1 from weight_versions);

-- ---- flags -----------------------------------------------------------------
-- Red flags surfaced during analysis.
create table if not exists flags (
  id            uuid primary key default gen_random_uuid(),
  candidate_id  uuid not null references candidates(id) on delete cascade,
  report_id     uuid not null references analysis_reports(id) on delete cascade,
  severity      flag_severity not null,
  code          text not null,
  message       text not null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_flags_candidate on flags(candidate_id);
create index if not exists idx_flags_report on flags(report_id);
create index if not exists idx_flags_severity on flags(severity);

-- ---- latest_candidate_scores (convenience view) ----------------------------
-- Most recent score row per candidate, joined for the dashboard.
create or replace view latest_candidate_scores as
select distinct on (s.candidate_id)
  s.candidate_id,
  s.id          as score_id,
  s.report_id,
  s.smart_money, s.earliness,
  s.profile, s.website, s.github, s.engagement, s.technical_depth, s.price,
  s.overall, s.verdict, s.created_at, s.weight_version_id
from scores s
order by s.candidate_id, s.created_at desc;

-- ---- provider_cache --------------------------------------------------------
-- TTL cache for external provider responses (X / GitHub / price), shared across
-- Trigger.dev job runs so repeat lookups don't re-hit rate-limited APIs.
create table if not exists provider_cache (
  key         text primary key,            -- "<namespace>:<id>"
  namespace   text not null,
  value       jsonb not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_provider_cache_expires on provider_cache(expires_at);

-- ---- outcomes --------------------------------------------------------------
-- Forward-return tracking: how did a scored, tokened candidate actually perform?
-- One row per report (seeded at scoring time with the entry-price baseline); the
-- scheduled `outcomes` job fills in later prices and freezes `forward_return`
-- once `matured`. This is the ground truth the weight backtester optimizes against.
create table if not exists outcomes (
  id                  uuid primary key default gen_random_uuid(),
  candidate_id        uuid not null references candidates(id) on delete cascade,
  report_id           uuid not null references analysis_reports(id) on delete cascade,
  token_ref           text,                         -- identifier used to re-lookup price
  baseline_price_usd  numeric,
  baseline_mcap_usd   numeric,
  baseline_at         timestamptz not null default now(),
  last_price_usd      numeric,
  last_mcap_usd       numeric,
  last_checked_at     timestamptz,
  forward_return      numeric,                      -- (last / baseline) - 1
  horizon_days        integer,
  matured             boolean not null default false,
  dataset             text not null default 'live',  -- 'live' | 'historical'
  measured_signals    text[],                        -- signals validly measured (historical sets)
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (report_id)
);

-- Additive migration for existing databases (no-op on fresh installs).
alter table outcomes add column if not exists dataset text not null default 'live';
alter table outcomes add column if not exists measured_signals text[];

create index if not exists idx_outcomes_candidate on outcomes(candidate_id);
create index if not exists idx_outcomes_matured on outcomes(matured);
create index if not exists idx_outcomes_dataset on outcomes(dataset);

drop trigger if exists trg_outcomes_updated_at on outcomes;
create trigger trg_outcomes_updated_at
  before update on outcomes
  for each row execute function set_updated_at();
