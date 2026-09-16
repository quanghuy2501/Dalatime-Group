-- Upgrade installations that already applied the original fixed-range audit migration.
alter table config_push_file_audit add column if not exists completed_sections jsonb not null default '[]'::jsonb;
alter table config_push_file_audit add column if not exists section_diff jsonb;
alter table config_push_file_audit drop constraint if exists config_push_file_audit_stage_check;
update config_push_file_audit set stage='sections_writing' where stage='config_written';
alter table config_push_file_audit add constraint config_push_file_audit_stage_check
  check (stage in ('sections_writing','complete','failed'));

comment on table config_push_file_audit is
  'Per-employee audit/checkpoint for the four allowlisted dynamic CONFIG sections; never report or salary sheets.';
