-- Onicorn Dashboard System - initial schema
-- Source of truth for Phase 1 DB mirror.

create extension if not exists pgcrypto;

create table if not exists source_files (
  id uuid primary key default gen_random_uuid(),
  google_file_id text unique not null,
  file_url text,
  file_name text not null,
  file_type text not null check (file_type in ('employee','customer_report','master')),
  nv_id text,
  staff_name text,
  folder_id text,
  active boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  client_code text unique,
  name text not null,
  status text,
  contact_name text,
  report_file_id text,
  raw_row jsonb,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists staff (
  id uuid primary key default gen_random_uuid(),
  nv_id text unique,
  name text not null,
  role text,
  channels_count integer default 0,
  report_file_id text,
  raw_row jsonb,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists brands (
  id uuid primary key default gen_random_uuid(),
  brand_code text unique,
  name text not null unique,
  client_code text,
  client_name text,
  group_name text,
  status text,
  raw_row jsonb,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists channels (
  id uuid primary key default gen_random_uuid(),
  channel_code text unique,
  name text not null unique,
  username text,
  url text,
  owner_name text,
  owner_staff_id uuid references staff(id),
  follower integer default 0,
  raw_row jsonb,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists posts_raw (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text unique not null,
  source_file_id text,
  source_sheet_name text not null default 'BAO CAO HANG NGAY',
  source_row integer,
  posted_date date,
  raw_posted_date text,
  posted_date_parse_ok boolean not null default true,
  brand_text_raw text,
  channel_name text,
  post_url text,
  owner_name text,
  is_exclusive boolean default false,
  viral_label text,
  realtime_view integer default 0,
  realtime_like integer default 0,
  realtime_comment integer default 0,
  realtime_save integer default 0,
  realtime_share integer default 0,
  snapshot_view integer default 0,
  snapshot_like integer default 0,
  snapshot_comment integer default 0,
  snapshot_save integer default 0,
  snapshot_share integer default 0,
  engagement_rate numeric default 0,
  status text,
  bonus_amount numeric default 0,
  show_channel text,
  viral_confirm_date date,
  synced_at timestamptz,
  source_hash text,
  raw_values jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists posts_raw_posted_date_idx on posts_raw(posted_date);
create index if not exists posts_raw_channel_idx on posts_raw(channel_name);
create index if not exists posts_raw_owner_idx on posts_raw(owner_name);
create index if not exists posts_raw_url_idx on posts_raw(post_url);

create table if not exists post_brands (
  id uuid primary key default gen_random_uuid(),
  post_raw_id uuid not null references posts_raw(id) on delete cascade,
  brand_name text not null,
  brand_id uuid references brands(id),
  source_brand_text text,
  posted_date date,
  channel_name text,
  owner_name text,
  post_url text,
  realtime_view integer default 0,
  realtime_like integer default 0,
  realtime_comment integer default 0,
  realtime_save integer default 0,
  realtime_share integer default 0,
  viral_label text,
  bonus_amount numeric default 0,
  unique(post_raw_id, brand_name)
);

create index if not exists post_brands_brand_idx on post_brands(brand_name);
create index if not exists post_brands_posted_date_idx on post_brands(posted_date);

create table if not exists bonus_rules (
  id uuid primary key default gen_random_uuid(),
  min_snapshot_view integer not null,
  max_snapshot_view integer,
  amount numeric not null default 0,
  active_from date not null default current_date,
  active_to date,
  raw_source text
);

create table if not exists bonus_results (
  id uuid primary key default gen_random_uuid(),
  post_raw_id uuid not null unique references posts_raw(id) on delete cascade,
  eligible boolean not null default false,
  reason text not null,
  amount numeric not null default 0,
  calculated_at timestamptz not null default now(),
  rule_id uuid references bonus_rules(id)
);

create table if not exists sync_runs (
  id uuid primary key default gen_random_uuid(),
  run_type text not null,
  status text not null check (status in ('running','ok','partial','fail')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,
  rows_read integer default 0,
  rows_written integer default 0,
  files_total integer default 0,
  files_ok integer default 0,
  files_fail integer default 0,
  error text,
  meta jsonb
);

create table if not exists sync_file_results (
  id uuid primary key default gen_random_uuid(),
  sync_run_id uuid references sync_runs(id) on delete cascade,
  google_file_id text,
  file_name text,
  status text not null,
  rows_read integer default 0,
  rows_written integer default 0,
  duration_ms integer,
  error text,
  meta jsonb
);

create table if not exists data_quality_issues (
  id uuid primary key default gen_random_uuid(),
  sync_run_id uuid references sync_runs(id) on delete set null,
  severity text not null check (severity in ('info','warn','error')),
  issue_type text not null,
  source_file_id text,
  source_row integer,
  post_raw_id uuid references posts_raw(id) on delete set null,
  message text not null,
  fixed boolean not null default false,
  created_at timestamptz not null default now()
);
