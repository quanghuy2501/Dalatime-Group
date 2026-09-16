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
  stage text not null check (stage in ('sections_writing','complete','failed')),
  status text not null,
  writes integer not null default 0,
  error text,
  duration_ms integer,
  completed_sections jsonb not null default '[]'::jsonb,
  section_diff jsonb,
  updated_at timestamptz not null default now(),
  primary key (run_id,google_file_id)
);

alter table config_push_file_audit add column if not exists completed_sections jsonb not null default '[]'::jsonb;
alter table config_push_file_audit add column if not exists section_diff jsonb;
alter table config_push_file_audit drop constraint if exists config_push_file_audit_stage_check;
update config_push_file_audit set stage='sections_writing' where stage='config_written';
alter table config_push_file_audit add constraint config_push_file_audit_stage_check check (stage in ('sections_writing','complete','failed'));
