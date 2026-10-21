-- Auditable publication history for the isolated Google Master reporting mirror.
-- This is additive and does not alter business facts or existing catalog rows.
create table if not exists master_mirror_runs (
  id uuid primary key default gen_random_uuid(),
  spreadsheet_id text not null,
  status text not null check (status in ('running','published','failed','blocked')),
  source_watermark timestamptz,
  raw_rows integer not null default 0,
  normalized_rows integer not null default 0,
  snapshot_hash text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,
  error text,
  manifest jsonb not null default '{}'::jsonb
);
create index if not exists master_mirror_runs_latest_idx on master_mirror_runs(started_at desc);
alter table master_mirror_runs enable row level security;
revoke all on table master_mirror_runs from anon, authenticated;
