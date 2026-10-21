-- Additive reporting read model.
-- Source mirrors remain untouched. Every canonical row retains the complete
-- source row-key set so an operator can trace any displayed metric back to the
-- exact employee-sheet rows that contributed to it.

drop materialized view if exists reporting_posts_canonical cascade;

create materialized view reporting_posts_canonical as
with normalized as (
  select p.*,
    case
      when nullif(trim(p.post_url), '') is null then p.row_key
      else regexp_replace(regexp_replace(lower(trim(p.post_url)), '\?.*$', ''), '/$', '')
    end as canonical_key
  from posts_raw_sheet p
), ranked as (
  select n.*,
    row_number() over (
      partition by n.canonical_key
      order by n.updated_at desc nulls last, n.row_key desc
    ) as canonical_rank
  from normalized n
), members as (
  select canonical_key,
    array_agg(row_key order by row_key) as source_row_keys,
    count(*)::integer as source_row_count
  from normalized
  group by canonical_key
), brand_groups as (
  select n.canonical_key,
    lower(regexp_replace(trim(pb.brand_name), '\s+', ' ', 'g')) as brand_key,
    min(trim(pb.brand_name)) as brand_name
  from normalized n
  join post_brands_sheet pb on pb.raw_sheet_row_key = n.row_key
  where nullif(trim(pb.brand_name), '') is not null
  group by n.canonical_key, lower(regexp_replace(trim(pb.brand_name), '\s+', ' ', 'g'))
), brand_map as (
  select canonical_key,
    array_agg(brand_name order by brand_key) as brand_names
  from brand_groups
  group by canonical_key
)
select r.id,r.row_key,r.source_file_id,r.source_row,r.posted_date,r.raw_posted_date,
  r.posted_date_parse_ok,r.brand_text_raw,r.channel_name,r.post_url,r.owner_name,
  r.is_exclusive,r.viral_label,r.realtime_view,r.realtime_like,r.realtime_comment,
  r.realtime_save,r.realtime_share,r.snapshot_view,r.snapshot_like,r.snapshot_comment,
  r.snapshot_save,r.snapshot_share,r.engagement_rate,r.status,r.bonus_amount,
  r.show_channel,r.viral_confirm_date,r.source_hash,r.raw_values,r.created_at,r.updated_at,
  r.published_run_id,r.config_version,r.canonical_key,
  m.source_row_keys,m.source_row_count,
  coalesce(b.brand_names, array[]::text[]) as brand_names
from ranked r
join members m using (canonical_key)
left join brand_map b using (canonical_key)
where r.canonical_rank = 1
with data;

create unique index reporting_posts_canonical_key_idx
  on reporting_posts_canonical(canonical_key);
create index reporting_posts_canonical_date_idx
  on reporting_posts_canonical(posted_date);
create index reporting_posts_canonical_channel_date_idx
  on reporting_posts_canonical(channel_name,posted_date);
create index reporting_posts_canonical_owner_date_idx
  on reporting_posts_canonical(owner_name,posted_date);
create index reporting_posts_canonical_brands_gin_idx
  on reporting_posts_canonical using gin(brand_names);

create or replace view reporting_posts_current as
select *
from reporting_posts_canonical
where posted_date is null or posted_date <= current_date;

comment on materialized view reporting_posts_canonical is
  'Derived, reversible reporting model: one latest row per canonical URL plus the union of brand mappings and exact source row keys.';
comment on view reporting_posts_current is
  'Canonical reporting rows excluding future-dated posts from business KPIs without modifying source data.';

