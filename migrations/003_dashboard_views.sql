create or replace view v_dashboard_overview as
select
  count(*)::int as posts,
  coalesce(sum(realtime_view),0)::bigint as view,
  coalesce(sum(realtime_like),0)::bigint as like,
  coalesce(sum(realtime_comment),0)::bigint as comment,
  coalesce(sum(realtime_save),0)::bigint as save,
  coalesce(sum(realtime_share),0)::bigint as share,
  coalesce(sum(realtime_like + realtime_comment + realtime_save + realtime_share),0)::bigint as interactions,
  case when coalesce(sum(realtime_view),0) > 0 then sum(realtime_like + realtime_comment + realtime_save + realtime_share)::numeric / sum(realtime_view) else 0 end as er,
  count(*) filter (where coalesce(viral_label,'') <> '')::int as viral,
  count(*) filter (where is_exclusive)::int as exclusive,
  count(distinct nullif(channel_name,''))::int as active_channels,
  count(distinct nullif(owner_name,''))::int as active_staff,
  count(*) filter (where posted_date >= current_date - interval '7 days')::int as posts_7d,
  coalesce(sum(realtime_view) filter (where posted_date >= current_date - interval '7 days'),0)::bigint as view_7d
from posts_raw;

create or replace view v_brand_performance as
select
  pb.brand_name,
  count(*)::int as posts,
  coalesce(sum(pb.realtime_view),0)::bigint as view,
  coalesce(sum(pb.realtime_like + pb.realtime_comment + pb.realtime_save + pb.realtime_share),0)::bigint as interactions,
  case when coalesce(sum(pb.realtime_view),0)>0 then sum(pb.realtime_like + pb.realtime_comment + pb.realtime_save + pb.realtime_share)::numeric / sum(pb.realtime_view) else 0 end as er,
  count(*) filter (where coalesce(pb.viral_label,'') <> '')::int as viral,
  max(pb.posted_date) as last_posted_date
from post_brands pb
group by pb.brand_name;

create or replace view v_staff_performance as
select
  coalesce(nullif(owner_name,''),'(Chưa gán)') as staff_name,
  count(*)::int as posts,
  coalesce(sum(realtime_view),0)::bigint as view,
  coalesce(sum(realtime_like + realtime_comment + realtime_save + realtime_share),0)::bigint as interactions,
  case when coalesce(sum(realtime_view),0)>0 then sum(realtime_like + realtime_comment + realtime_save + realtime_share)::numeric / sum(realtime_view) else 0 end as er,
  count(*) filter (where coalesce(viral_label,'') <> '')::int as viral,
  coalesce(sum(br.amount),0)::bigint as bonus_amount,
  max(posted_date) as last_posted_date
from posts_raw p
left join bonus_results br on br.post_raw_id = p.id
group by coalesce(nullif(owner_name,''),'(Chưa gán)');

create or replace view v_channel_performance as
select
  coalesce(nullif(channel_name,''),'(Chưa gán)') as channel_name,
  count(*)::int as posts,
  coalesce(sum(realtime_view),0)::bigint as view,
  coalesce(sum(realtime_like + realtime_comment + realtime_save + realtime_share),0)::bigint as interactions,
  case when coalesce(sum(realtime_view),0)>0 then sum(realtime_like + realtime_comment + realtime_save + realtime_share)::numeric / sum(realtime_view) else 0 end as er,
  count(*) filter (where coalesce(viral_label,'') <> '')::int as viral,
  max(posted_date) as last_posted_date
from posts_raw
group by coalesce(nullif(channel_name,''),'(Chưa gán)');

create or replace view v_quality_summary as
select issue_type, severity, count(*)::int as count
from data_quality_issues
where fixed = false
group by issue_type, severity;
