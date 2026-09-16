-- Auditable, resumable Master CONFIG -> employee spreadsheet pushes.
create table if not exists config_push_runs (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('dry-run','production')),
  status text not null check (status in ('running','ok','partial','failed')),
  snapshot_version text not null,
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  files_total integer not null default 0,
  files_ok integer not null default 0,
  files_fail integer not null default 0,
  writes integer not null default 0,
  summary jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists config_push_runs_resume_idx on config_push_runs(snapshot_hash,started_at desc);

create table if not exists config_push_file_audit (
  run_id uuid not null references config_push_runs(id) on delete cascade,
  nv_id text not null,
  google_file_id text not null,
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  stage text not null check (stage in ('config_written','complete','failed')),
  status text not null,
  writes integer not null default 0,
  error text,
  duration_ms integer,
  updated_at timestamptz not null default now(),
  primary key (run_id,google_file_id)
);
