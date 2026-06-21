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

create index if not exists idx_scores_candidate on scores(candidate_id);
create index if not exists idx_scores_report on scores(report_id);
create index if not exists idx_scores_verdict on scores(verdict);
create index if not exists idx_scores_overall on scores(overall desc);

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
  s.profile, s.website, s.github, s.engagement, s.technical_depth, s.price,
  s.overall, s.verdict, s.created_at
from scores s
order by s.candidate_id, s.created_at desc;
