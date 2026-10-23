create table if not exists ai_analyst_audit (
  id uuid primary key default gen_random_uuid(), actor text not null, scope text not null,
  period text not null, model text not null, question_hash text not null,
  status text not null check (status in ('ok','error')), source_count integer not null default 0,
  latency_ms integer not null default 0, error_code text, created_at timestamptz not null default now()
);
create index if not exists ai_analyst_audit_created_idx on ai_analyst_audit(created_at desc);
create or replace function block_ai_analyst_audit_mutation() returns trigger language plpgsql as $$ begin raise exception 'ai_analyst_audit is append-only'; end $$;
drop trigger if exists ai_analyst_audit_append_only on ai_analyst_audit;
create trigger ai_analyst_audit_append_only before update or delete on ai_analyst_audit for each row execute function block_ai_analyst_audit_mutation();
alter table ai_analyst_audit enable row level security;
revoke all on table ai_analyst_audit from anon, authenticated;
