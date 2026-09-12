-- Canonical ER contract: decimal ratio in storage/query layers; percent in UI only.
-- Retain an immutable, timestamped audit backup before deriving ER from metrics.
begin;

create table if not exists engagement_rate_backups (
  backed_up_at timestamptz not null default now(),
  source_table text not null,
  row_id uuid not null,
  old_engagement_rate numeric,
  realtime_view integer,
  realtime_like integer,
  realtime_comment integer,
  realtime_save integer,
  realtime_share integer,
  primary key (source_table, row_id, backed_up_at)
);

insert into engagement_rate_backups
  (source_table,row_id,old_engagement_rate,realtime_view,realtime_like,realtime_comment,realtime_save,realtime_share)
select 'posts_raw_sheet',id,engagement_rate,realtime_view,realtime_like,realtime_comment,realtime_save,realtime_share
from posts_raw_sheet
where engagement_rate is distinct from case when coalesce(realtime_view,0)>0 then
  (coalesce(realtime_like,0)+coalesce(realtime_comment,0)+coalesce(realtime_save,0)+coalesce(realtime_share,0))::numeric/realtime_view else 0 end;

update posts_raw_sheet set engagement_rate=case when coalesce(realtime_view,0)>0 then
  (coalesce(realtime_like,0)+coalesce(realtime_comment,0)+coalesce(realtime_save,0)+coalesce(realtime_share,0))::numeric/realtime_view else 0 end
where engagement_rate is distinct from case when coalesce(realtime_view,0)>0 then
  (coalesce(realtime_like,0)+coalesce(realtime_comment,0)+coalesce(realtime_save,0)+coalesce(realtime_share,0))::numeric/realtime_view else 0 end;

insert into engagement_rate_backups
  (source_table,row_id,old_engagement_rate,realtime_view,realtime_like,realtime_comment,realtime_save,realtime_share)
select 'posts_raw',id,engagement_rate,realtime_view,realtime_like,realtime_comment,realtime_save,realtime_share
from posts_raw
where engagement_rate is distinct from case when coalesce(realtime_view,0)>0 then
  (coalesce(realtime_like,0)+coalesce(realtime_comment,0)+coalesce(realtime_save,0)+coalesce(realtime_share,0))::numeric/realtime_view else 0 end;

update posts_raw set engagement_rate=case when coalesce(realtime_view,0)>0 then
  (coalesce(realtime_like,0)+coalesce(realtime_comment,0)+coalesce(realtime_save,0)+coalesce(realtime_share,0))::numeric/realtime_view else 0 end
where engagement_rate is distinct from case when coalesce(realtime_view,0)>0 then
  (coalesce(realtime_like,0)+coalesce(realtime_comment,0)+coalesce(realtime_save,0)+coalesce(realtime_share,0))::numeric/realtime_view else 0 end;

comment on column posts_raw_sheet.engagement_rate is 'Decimal ratio: (like+comment+save+share)/view; 0 when view is zero';
comment on column posts_raw.engagement_rate is 'Decimal ratio: (like+comment+save+share)/view; 0 when view is zero';

create or replace view v_dashboard_overview as select count(*)::int posts,
  coalesce(sum(realtime_view),0)::bigint view, coalesce(sum(realtime_like),0)::bigint like,
  coalesce(sum(realtime_comment),0)::bigint comment, coalesce(sum(realtime_save),0)::bigint save,
  coalesce(sum(realtime_share),0)::bigint share,
  coalesce(sum(realtime_like+realtime_comment+realtime_save+realtime_share),0)::bigint interactions,
  case when coalesce(sum(realtime_view),0)>0 then sum(realtime_like+realtime_comment+realtime_save+realtime_share)::numeric/sum(realtime_view) else 0 end er,
  count(*) filter(where coalesce(viral_label,'')<>'')::int viral, count(*) filter(where is_exclusive)::int exclusive,
  count(distinct nullif(channel_name,''))::int active_channels, count(distinct nullif(owner_name,''))::int active_staff,
  count(*) filter(where posted_date>=current_date-interval '7 days')::int posts_7d,
  coalesce(sum(realtime_view) filter(where posted_date>=current_date-interval '7 days'),0)::bigint view_7d from posts_raw;

create or replace view v_brand_performance as select pb.brand_name,count(*)::int posts,
  coalesce(sum(pb.realtime_view),0)::bigint view,
  coalesce(sum(pb.realtime_like+pb.realtime_comment+pb.realtime_save+pb.realtime_share),0)::bigint interactions,
  case when coalesce(sum(pb.realtime_view),0)>0 then sum(pb.realtime_like+pb.realtime_comment+pb.realtime_save+pb.realtime_share)::numeric/sum(pb.realtime_view) else 0 end er,
  count(*) filter(where coalesce(pb.viral_label,'')<>'')::int viral,max(pb.posted_date) last_posted_date
  from post_brands pb group by pb.brand_name;

create or replace view v_staff_performance as select coalesce(nullif(owner_name,''),'(Chưa gán)') staff_name,
  count(*)::int posts,coalesce(sum(realtime_view),0)::bigint view,
  coalesce(sum(realtime_like+realtime_comment+realtime_save+realtime_share),0)::bigint interactions,
  case when coalesce(sum(realtime_view),0)>0 then sum(realtime_like+realtime_comment+realtime_save+realtime_share)::numeric/sum(realtime_view) else 0 end er,
  count(*) filter(where coalesce(viral_label,'')<>'')::int viral,coalesce(sum(br.amount),0)::bigint bonus_amount,
  max(posted_date) last_posted_date from posts_raw p left join bonus_results br on br.post_raw_id=p.id
  group by coalesce(nullif(owner_name,''),'(Chưa gán)');

create or replace view v_channel_performance as select coalesce(nullif(channel_name,''),'(Chưa gán)') channel_name,
  count(*)::int posts,coalesce(sum(realtime_view),0)::bigint view,
  coalesce(sum(realtime_like+realtime_comment+realtime_save+realtime_share),0)::bigint interactions,
  case when coalesce(sum(realtime_view),0)>0 then sum(realtime_like+realtime_comment+realtime_save+realtime_share)::numeric/sum(realtime_view) else 0 end er,
  count(*) filter(where coalesce(viral_label,'')<>'')::int viral,max(posted_date) last_posted_date
  from posts_raw group by coalesce(nullif(channel_name,''),'(Chưa gán)');

commit;
