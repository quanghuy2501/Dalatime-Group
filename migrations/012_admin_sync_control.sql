create table if not exists admin_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  action text not null check (action in ('config_push','direct_nv_sync','report_refresh_reconcile','full_pipeline')),
  status text not null check (status in ('queued','running','succeeded','failed','blocked')),
  idempotency_key text not null,
  requested_by text not null,
  attempt integer not null default 1,
  logs jsonb not null default '[]'::jsonb,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(action,idempotency_key)
);
alter table admin_sync_jobs drop constraint if exists admin_sync_jobs_status_check;
alter table admin_sync_jobs add constraint admin_sync_jobs_status_check check (status in ('queued','running','succeeded','failed','blocked'));

create index if not exists admin_sync_jobs_queue_idx on admin_sync_jobs(status,created_at);
create unique index if not exists admin_sync_jobs_one_active_action_idx on admin_sync_jobs(action) where status in ('queued','running');
