-- The locked Master contains legitimate historical duplicates (KH00083,
-- channel names, and one brand name). Exact mirrors must retain those rows.
do $$
declare item record; constraint_name text;
begin
  for item in select * from (values ('clients','client_code'),('channels','name'),('brands','name')) v(tbl,col)
  loop
    for constraint_name in select conname from pg_constraint
      where conrelid = format('public.%I',item.tbl)::regclass and contype = 'u'
        and conkey = array[(select attnum from pg_attribute where attrelid=format('public.%I',item.tbl)::regclass and attname=item.col)]
    loop
      execute format('alter table public.%I drop constraint %I', item.tbl, constraint_name);
    end loop;
  end loop;
end $$;
create index if not exists clients_client_code_idx on public.clients(client_code);
create index if not exists channels_name_idx on public.channels(name);
create index if not exists brands_name_idx on public.brands(name);
