-- Master `2. NHAN SU`.`TÌNH TRẠNG` is the lifecycle authority for employee files.
alter table nv_ingestion_sources
  add column if not exists master_registry_present boolean not null default false;

comment on column nv_ingestion_sources.status is
  'Verbatim Master 2. NHAN SU TÌNH TRẠNG; blank means active';
comment on column nv_ingestion_sources.master_registry_present is
  'Set by read-only Master registry discovery; false sources are never targeted';
