-- The web service connects as the trusted database owner. Supabase REST roles
-- must never bypass application authentication or mutate business tables.
-- This migration changes authorization only; it does not update business rows.

do $$
declare
  item record;
  role_name text;
begin
  for role_name in select rolname from pg_roles where rolname in ('anon','authenticated') loop
    for item in
      select n.nspname schema_name,c.relname relation_name,c.relkind
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p','v','m','S')
    loop
      execute format('revoke all privileges on %I.%I from %I',item.schema_name,item.relation_name,role_name);
      if item.relkind in ('r','p') then
        execute format('alter table %I.%I enable row level security',item.schema_name,item.relation_name);
      end if;
    end loop;
    execute format('alter default privileges in schema public revoke all on tables from %I',role_name);
    execute format('alter default privileges in schema public revoke all on sequences from %I',role_name);
    execute format('alter default privileges in schema public revoke all on functions from %I',role_name);
  end loop;
end $$;

