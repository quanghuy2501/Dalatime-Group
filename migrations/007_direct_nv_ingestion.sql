-- Direct employee (NV) Google Sheets -> published dashboard mirror.
-- Master remains configuration/registry only; employee rows are staged per run.
create table if not exists nv_config_versions (
  version text primary key,
  master_sync_run_id uuid references sync_runs(id) on delete restrict,
  mapping jsonb not null,
  active boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists nv_config_versions_one_active_idx on nv_config_versions(active) where active;

create or replace function register_nv_config_from_master_sync() returns trigger language plpgsql as $$
declare exact_mapping jsonb := '[
 ["NGÀY ĐĂNG BÀI","posted_date"],["TÊN THƯƠNG HIỆU","brand_text_raw"],["TÊN KÊNH","channel_name"],["LINK BÀI ĐĂNG","post_url"],
 ["NGƯỜI PHỤ TRÁCH","owner_name"],["ĐỘC QUYỀN","is_exclusive"],["VIRAL","viral_label"],["VIEW","realtime_view"],["LIKE","realtime_like"],
 ["COMMENT","realtime_comment"],["SAVE","realtime_save"],["SHARE","realtime_share"],["VIEW_SNAPSHOOT","snapshot_view"],
 ["LIKE_SNAPSHOOT","snapshot_like"],["COMMENT_SNAPSHOOT","snapshot_comment"],["SAVE_SNAPSHOOT","snapshot_save"],
 ["SHARE_SNAPSHOOT","snapshot_share"],["% TƯƠNG TÁC","engagement_rate"],["TRẠNG THÁI","status"],["THƯỞNG VIRAL","bonus_amount"],
 ["SHOW TÊN KÊNH","show_channel"],["NGÀY XÁC NHẬN VIRAL","viral_confirm_date"]]';
begin
  if new.status='ok' and new.run_type like '%master%' then
    update nv_config_versions set active=false where active;
    insert into nv_config_versions(version,master_sync_run_id,mapping,active)
      values('master-sync:'||new.id,new.id,exact_mapping,true)
      on conflict(version) do update set mapping=excluded.mapping,active=true;
  end if;
  return new;
end $$;
drop trigger if exists sync_runs_register_nv_config on sync_runs;
create trigger sync_runs_register_nv_config after insert or update of status on sync_runs
  for each row execute function register_nv_config_from_master_sync();

-- Bootstrap config provenance when this migration follows an already-successful Master sync.
update sync_runs set status=status where id=(select id from sync_runs where status='ok' and run_type like '%master%'
  order by finished_at desc nulls last limit 1);

create table if not exists nv_ingestion_sources (
  nv_id text primary key,
  google_file_id text not null unique,
  sheet_name text not null default 'BAO CAO HANG NGAY',
  active boolean not null default true,
  expected_columns integer not null default 22 check (expected_columns = 22),
  updated_at timestamptz not null default now(),
  check (lower(google_file_id) <> lower(coalesce(current_setting('app.master_spreadsheet_id', true), '')))
);

create table if not exists nv_ingestion_checkpoints (
  run_id uuid not null references sync_runs(id) on delete cascade,
  nv_id text not null,
  google_file_id text not null,
  sheet_name text not null,
  next_row integer not null,
  rows_read integer not null default 0,
  status text not null check (status in ('running','ok','fail','skipped')),
  error text,
  updated_at timestamptz not null default now(),
  primary key (run_id, google_file_id, sheet_name)
);

create table if not exists nv_posts_staging (
  run_id uuid not null references sync_runs(id) on delete cascade,
  row_key text not null,
  nv_id text not null,
  source_file_id text not null,
  source_sheet_name text not null,
  source_row integer not null,
  config_version text not null references nv_config_versions(version),
  mapped_row jsonb not null,
  source_hash text not null,
  primary key (run_id, row_key),
  unique (run_id, source_file_id, source_sheet_name, source_row)
);
create index if not exists nv_posts_staging_run_idx on nv_posts_staging(run_id);

alter table posts_raw_sheet add column if not exists published_run_id uuid references sync_runs(id);
alter table posts_raw_sheet add column if not exists config_version text;
alter table post_brands_sheet add column if not exists published_run_id uuid references sync_runs(id);

create table if not exists nv_published_snapshots (
  singleton boolean primary key default true check (singleton),
  run_id uuid not null unique references sync_runs(id),
  config_version text not null references nv_config_versions(version),
  row_count integer not null,
  fingerprint text not null,
  published_at timestamptz not null default now()
);
