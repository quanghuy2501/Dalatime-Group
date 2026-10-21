-- Web catalog administration. This migration is additive and never rewrites
-- existing business rows; legacy Master payloads remain intact in raw_row.

alter table clients add column if not exists phone text;
alter table clients add column if not exists tax_id text;
alter table clients add column if not exists address text;
alter table clients add column if not exists email text;
alter table clients add column if not exists invoice_required boolean;
alter table clients add column if not exists created_at timestamptz not null default now();
alter table clients add column if not exists change_version integer not null default 1;

alter table brands add column if not exists start_date date;
alter table brands add column if not exists end_date date;
alter table brands add column if not exists created_at timestamptz not null default now();
alter table brands add column if not exists change_version integer not null default 1;
alter table brands add column if not exists config_sort_order integer;
alter table brands add column if not exists config_visible boolean not null default true;

alter table staff add column if not exists phone text;
alter table staff add column if not exists email text;
alter table staff add column if not exists base_salary numeric;
alter table staff add column if not exists employment_type text;
alter table staff add column if not exists status text;
alter table staff add column if not exists created_at timestamptz not null default now();
alter table staff add column if not exists change_version integer not null default 1;
alter table staff add column if not exists config_sort_order integer;
alter table staff add column if not exists config_visible boolean not null default true;

alter table channels add column if not exists created_at timestamptz not null default now();
alter table channels add column if not exists change_version integer not null default 1;
alter table channels add column if not exists config_sort_order integer;
alter table channels add column if not exists config_visible boolean not null default true;

create table if not exists admin_catalog_audit (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('clients','brands','staff','channels')),
  entity_id uuid not null,
  entity_code text not null,
  action text not null check (action in ('create','update','activate','deactivate')),
  actor text not null,
  before_data jsonb,
  after_data jsonb not null,
  changed_fields text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists admin_catalog_audit_entity_idx
  on admin_catalog_audit(entity_type,entity_id,created_at desc);
create index if not exists admin_catalog_audit_created_idx
  on admin_catalog_audit(created_at desc);

comment on table admin_catalog_audit is
  'Immutable web-admin audit history. No DELETE API is exposed for catalog entities.';

create or replace function block_admin_catalog_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'admin_catalog_audit is append-only';
end;
$$;

drop trigger if exists admin_catalog_audit_append_only on admin_catalog_audit;
create trigger admin_catalog_audit_append_only
before update or delete on admin_catalog_audit
for each row execute function block_admin_catalog_audit_mutation();
