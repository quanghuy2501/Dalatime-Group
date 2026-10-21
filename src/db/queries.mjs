function rangeWhere(alias, params = {}) {
  const where = [];
  const vals = [];
  const col = `${alias}.posted_date`;
  if (params.from) { vals.push(params.from); where.push(`${col} >= $${vals.length}`); }
  if (params.to) { vals.push(params.to); where.push(`${col} <= $${vals.length}`); }
  return { where, vals };
}

const interactionsSql = alias => `coalesce(${alias}.realtime_like,0)+coalesce(${alias}.realtime_comment,0)+coalesce(${alias}.realtime_save,0)+coalesce(${alias}.realtime_share,0)`;
const REPORTING_POSTS = 'reporting_posts_current';

const currentIssuesCte = () => `with brand_master as materialized (
  select lower(regexp_replace(trim(name),'\\s+',' ','g')) brand_key,count(*)::int master_matches,
    count(*) filter(where active)::int active_matches from brands group by 1
),channel_master as materialized (
  select distinct lower(trim(name)) channel_key from channels
),current_issues as (
  select 'future_posted_date'::text issue_type,'error'::text severity,
    'Ngày đăng nằm trong tương lai: '||posted_date::text message,source_file_id,source_row,updated_at created_at
  from reporting_posts_canonical where posted_date>current_date
  union all
  select 'missing_posted_date','warn','Thiếu ngày đăng',source_file_id,source_row,updated_at
  from reporting_posts_current where posted_date is null
  union all
  select 'missing_post_url','warn','Thiếu link bài đăng',source_file_id,source_row,updated_at
  from reporting_posts_current where nullif(trim(post_url),'') is null
  union all
  select 'duplicate_source_rows','info','URL canonical có '||source_row_count::text||' dòng nguồn',source_file_id,source_row,updated_at
  from reporting_posts_current where source_row_count>1
  union all
  select 'brand_not_in_master','warn','Brand chưa khớp danh mục: '||bn.brand_name,p.source_file_id,p.source_row,p.updated_at
  from reporting_posts_current p cross join lateral unnest(p.brand_names) bn(brand_name)
  left join brand_master bm on bm.brand_key=lower(regexp_replace(trim(bn.brand_name),'\\s+',' ','g'))
  where bm.brand_key is null
  union all
  select 'ambiguous_brand_master','error','Brand trùng danh mục active: '||bn.brand_name,p.source_file_id,p.source_row,p.updated_at
  from reporting_posts_current p cross join lateral unnest(p.brand_names) bn(brand_name)
  join brand_master bm on bm.brand_key=lower(regexp_replace(trim(bn.brand_name),'\\s+',' ','g')) and bm.active_matches>1
  union all
  select 'channel_not_in_master','warn','Kênh chưa khớp danh mục: '||channel_name,source_file_id,source_row,updated_at
  from reporting_posts_current p left join channel_master cm on cm.channel_key=lower(trim(p.channel_name))
  where nullif(trim(channel_name),'') is not null and cm.channel_key is null
  union all
  select 'missing_metrics','info','Bài đăng chưa có view hoặc tương tác',source_file_id,source_row,updated_at
  from reporting_posts_current where coalesce(realtime_view,0)=0 and ${interactionsSql('reporting_posts_current')}=0
)`;

export async function getOverview(db, params = {}) {
  const { where, vals } = rangeWhere('p', params);
  const sql = `select
    count(*)::int as posts,
    coalesce(sum(p.realtime_view),0)::bigint as view,
    coalesce(sum(p.realtime_like),0)::bigint as like,
    coalesce(sum(p.realtime_comment),0)::bigint as comment,
    coalesce(sum(p.realtime_save),0)::bigint as save,
    coalesce(sum(p.realtime_share),0)::bigint as share,
    coalesce(sum(${interactionsSql('p')}),0)::bigint as interactions,
    case when coalesce(sum(p.realtime_view),0)>0 then sum(${interactionsSql('p')})::numeric / sum(p.realtime_view) else 0 end as er,
    count(*) filter (where coalesce(p.viral_label,'') <> '')::int as viral,
    count(*) filter (where p.is_exclusive)::int as exclusive,
    count(distinct nullif(p.channel_name,''))::int as active_channels,
    count(distinct nullif(p.owner_name,''))::int as active_staff,
    count(*) filter (where p.posted_date between current_date - interval '6 days' and current_date)::int as posts_7d,
    coalesce(sum(p.realtime_view) filter (where p.posted_date between current_date - interval '6 days' and current_date),0)::bigint as view_7d
    from ${REPORTING_POSTS} p ${where.length ? 'where ' + where.join(' and ') : ''}`;
  return (await db.query(sql, vals)).rows[0];
}

async function grouped(db, table, alias, keySql, params, limit = 50) {
  const { where, vals } = rangeWhere(alias, params);
  vals.push(limit); const limitParam = `$${vals.length}`;
  const sql = `select ${keySql} as name,
    count(*)::int as posts,
    coalesce(sum(${alias}.realtime_view),0)::bigint as view,
    coalesce(sum(${interactionsSql(alias)}),0)::bigint as interactions,
    case when coalesce(sum(${alias}.realtime_view),0)>0 then sum(${interactionsSql(alias)})::numeric / sum(${alias}.realtime_view) else 0 end as er,
    count(*) filter (where coalesce(${alias}.viral_label,'') <> '')::int as viral,
    max(${alias}.posted_date) as last_posted_date
    from ${table} ${alias}
    ${where.length ? 'where ' + where.join(' and ') : ''}
    group by ${keySql}
    order by view desc nulls last limit ${limitParam}`;
  return (await db.query(sql, vals)).rows;
}

export async function getTopBrands(db, limit = 50, params = {}) {
  const { where, vals } = rangeWhere('p', params);
  vals.push(limit); const limitParam = `$${vals.length}`;
  const rows = await db.query(`select brand_name as name,count(*)::int posts,
    coalesce(sum(p.realtime_view),0)::bigint view,coalesce(sum(${interactionsSql('p')}),0)::bigint interactions,
    case when coalesce(sum(p.realtime_view),0)>0 then sum(${interactionsSql('p')})::numeric/sum(p.realtime_view) else 0 end er,
    count(*) filter(where coalesce(p.viral_label,'')<>'')::int viral,max(p.posted_date) last_posted_date
    from ${REPORTING_POSTS} p cross join lateral unnest(p.brand_names) brand_name
    ${where.length ? 'where ' + where.join(' and ') : ''}
    group by brand_name order by view desc nulls last limit ${limitParam}`, vals);
  return rows.rows.map(r => ({ brand_name: r.name, ...r }));
}

export async function getTopStaff(db, limit = 50, params = {}) {
  const { where, vals } = rangeWhere('p', params);
  vals.push(limit); const limitParam = `$${vals.length}`;
  const sql = `select coalesce(nullif(p.owner_name,''),'(Chưa gán)') as staff_name,
    count(*)::int as posts, coalesce(sum(p.realtime_view),0)::bigint as view,
    coalesce(sum(${interactionsSql('p')}),0)::bigint as interactions,
    case when coalesce(sum(p.realtime_view),0)>0 then sum(${interactionsSql('p')})::numeric/sum(p.realtime_view) else 0 end as er,
    count(*) filter (where coalesce(p.viral_label,'') <> '')::int as viral,
    coalesce(sum(p.bonus_amount),0)::bigint as bonus_amount,
    max(p.posted_date) as last_posted_date
    from ${REPORTING_POSTS} p
    ${where.length ? 'where ' + where.join(' and ') : ''}
    group by coalesce(nullif(p.owner_name,''),'(Chưa gán)') order by view desc nulls last limit ${limitParam}`;
  return (await db.query(sql, vals)).rows;
}

export async function getTopChannels(db, limit = 50, params = {}) {
  const rows = await grouped(db, REPORTING_POSTS, 'p', `coalesce(nullif(p.channel_name,''),'(Chưa gán)')`, params, limit);
  return rows.map(r => ({ channel_name: r.name, ...r }));
}

export async function getMasters(db) {
  const [brands, staff, channels, clients] = await Promise.all([
    db.query(`select brand_code as id,name,group_name as "group",client_name as client,status,active from brands order by active desc,name`),
    db.query(`select nv_id as id,name,role,channels_count as channels,active from staff order by active desc,name`),
    db.query(`select channel_code as id,name,username,owner_name as owner,follower,url,active from channels order by active desc,name`),
    db.query(`select client_code as id,name,status,contact_name as contact,active from clients order by active desc,name`)
  ]);
  return { brands: brands.rows, staff: staff.rows, channels: channels.rows, clients: clients.rows };
}

export async function getAlerts(db) {
  const [brandDrops, staffDrops, sleepingChannels, failedSync, trending, viralChannels] = await Promise.all([
    db.query(`with stats as (select pb.brand_name as name,
      coalesce(sum(p.realtime_view) filter (where p.posted_date between current_date-interval '6 days' and current_date),0)::bigint as view,
      coalesce(sum(p.realtime_view) filter (where p.posted_date between current_date-interval '13 days' and current_date-interval '7 days'),0)::bigint as view_prev
      from ${REPORTING_POSTS} p cross join lateral unnest(p.brand_names) pb(brand_name)
      group by pb.brand_name)
      select name,view,"view_prev" as "viewPrev",round((view-view_prev)::numeric/nullif(view_prev,0)*100,1) as change from stats
      where view_prev>100 and (view-view_prev)::numeric/view_prev < -.3 order by change limit 8`),
    db.query(`with stats as (select coalesce(nullif(owner_name,''),'(Chưa gán)') as name,
      coalesce(sum(realtime_view) filter (where posted_date between current_date-interval '6 days' and current_date),0)::bigint as view,
      coalesce(sum(realtime_view) filter (where posted_date between current_date-interval '13 days' and current_date-interval '7 days'),0)::bigint as view_prev
      from ${REPORTING_POSTS} group by coalesce(nullif(owner_name,''),'(Chưa gán)'))
      select name,view,"view_prev" as "viewPrev",round((view-view_prev)::numeric/nullif(view_prev,0)*100,1) as change from stats
      where view_prev>100 and (view-view_prev)::numeric/view_prev < -.3 order by change limit 8`),
    db.query(`select c.name,c.owner_name as owner,
      coalesce((current_date-max(p.posted_date))::int,999) as "lastPostDays",max(p.posted_date)::date as "lastPostDate"
      from channels c left join ${REPORTING_POSTS} p on lower(trim(p.channel_name))=lower(trim(c.name))
      where c.active group by c.name,c.owner_name having max(p.posted_date) is null or max(p.posted_date)<current_date-interval '14 days'
      order by "lastPostDays" desc limit 20`),
    db.query(`select started_at as timestamp,run_type as job,status,error from sync_runs where status='fail' order by started_at desc limit 10`),
    db.query(`select posted_date as date,brand_text_raw as brand,channel_name as channel,owner_name as owner,realtime_view as view,post_url as link
      from ${REPORTING_POSTS} where posted_date between current_date-interval '6 days' and current_date order by realtime_view desc nulls last limit 5`),
    db.query(`select coalesce(nullif(channel_name,''),'(Chưa gán)') as name,count(*)::int as viral from ${REPORTING_POSTS}
      where coalesce(viral_label,'')<>'' group by coalesce(nullif(channel_name,''),'(Chưa gán)') order by viral desc limit 5`)
  ]);
  return { brandsDrop: brandDrops.rows, staffDrop: staffDrops.rows, sleepingChannels: sleepingChannels.rows, failedSync: failedSync.rows, trending: trending.rows, topViralChannels: viralChannels.rows };
}

export async function getHeatmap(db, params = {}) {
  const { where, vals } = rangeWhere('p', params);
  const filter = where.length ? `and ${where.join(' and ')}` : `and p.posted_date>=current_date-interval '56 days'`;
  const rows = await db.query(`select brand_name as brand,date_trunc('week',p.posted_date)::date as week,
    coalesce(sum(p.realtime_view),0)::bigint as view from ${REPORTING_POSTS} p
    cross join lateral unnest(p.brand_names) brand_name
    where p.posted_date is not null ${filter} group by brand_name,date_trunc('week',p.posted_date) order by week,view desc`, vals);
  return rows.rows;
}

export async function getQualitySummary(db) {
  return (await db.query(`${currentIssuesCte()} select issue_type,severity,count(*)::int count from current_issues group by issue_type,severity order by count desc`)).rows;
}

export async function getPosts(db, { limit = 100, offset = 0, q = '', brand = '', channel = '', staff = '', from = '', to = '', sort = 'view', dir = 'desc' } = {}) {
  const sortMap = { date: 'p.posted_date', view: 'p.realtime_view', like: 'p.realtime_like', comment: 'p.realtime_comment', save: 'p.realtime_save', share: 'p.realtime_share', er: 'p.engagement_rate', viral: 'p.viral_label' };
  const sortSql = sortMap[sort] || sortMap.view;
  const dirSql = String(dir).toLowerCase() === 'asc' ? 'asc' : 'desc';
  const where = [];
  const vals = [];
  if (q) { vals.push(`%${q.trim()}%`); const p = `$${vals.length}`; where.push(`(p.brand_text_raw ilike ${p} or p.channel_name ilike ${p} or p.owner_name ilike ${p} or p.post_url ilike ${p})`); }
  if (brand) { vals.push(`%${brand.trim()}%`); where.push(`exists (select 1 from unnest(p.brand_names) pbf(brand_name) where pbf.brand_name ilike $${vals.length})`); }
  if (channel) { vals.push(channel.trim()); where.push(`lower(trim(p.channel_name)) = lower($${vals.length})`); }
  if (staff) { vals.push(staff.trim()); where.push(`lower(trim(p.owner_name)) = lower($${vals.length})`); }
  if (from) { vals.push(from); where.push(`p.posted_date >= $${vals.length}`); }
  if (to) { vals.push(to); where.push(`p.posted_date <= $${vals.length}`); }
  const countVals = vals.slice();
  const safeLimit = Math.min(Math.max(Math.trunc(Number(limit)) || 100, 1), 500);
  const safeOffset = Math.max(Math.trunc(Number(offset)) || 0, 0);
  vals.push(safeLimit); const limitParam = `$${vals.length}`;
  vals.push(safeOffset); const offsetParam = `$${vals.length}`;
  const whereSql = where.length ? 'where ' + where.join(' and ') : '';
  const sql = `select p.id, p.posted_date::text as posted_date, p.brand_text_raw,
    coalesce(nullif(array_to_string(p.brand_names, ', '),''), nullif(p.brand_text_raw,''), '(Chưa tag brand)') as brand_names,
    p.channel_name, p.owner_name, p.post_url,
    p.realtime_view, p.realtime_like, p.realtime_comment, p.realtime_save, p.realtime_share,
    p.snapshot_view, p.is_exclusive, p.viral_label,
    case when coalesce(p.realtime_view,0)>0 then (${interactionsSql('p')})::numeric/p.realtime_view else 0 end as engagement_rate,
    p.bonus_amount, p.bonus_amount as calculated_bonus, null::text as bonus_reason
    from ${REPORTING_POSTS} p
    ${whereSql} order by ${sortSql} ${dirSql} nulls last limit ${limitParam} offset ${offsetParam}`;
  const countSql = `select count(*)::int count from ${REPORTING_POSTS} p ${whereSql}`;
  const [rows, count] = await Promise.all([db.query(sql, vals), db.query(countSql, countVals)]);
  return { rows: rows.rows, total: count.rows[0].count, limit: safeLimit, offset: safeOffset };
}

export async function getTimeseries(db, params = {}) {
  const { where, vals } = rangeWhere('p', params);
  const sql = `select p.posted_date::date as date,
    count(*)::int as posts,
    coalesce(sum(p.realtime_view),0)::bigint as view,
    coalesce(sum(${interactionsSql('p')}),0)::bigint as interactions,
    case when coalesce(sum(p.realtime_view),0)>0 then sum(${interactionsSql('p')})::numeric / sum(p.realtime_view) else 0 end as er,
    count(*) filter (where coalesce(p.viral_label,'') <> '')::int as viral
    from ${REPORTING_POSTS} p
    where p.posted_date is not null ${where.length ? 'and ' + where.join(' and ') : ''}
    group by p.posted_date::date
    order by date asc`;
  return (await db.query(sql, vals)).rows;
}

export async function getIssueTypes(db) {
  return (await db.query(`${currentIssuesCte()} select issue_type,severity,count(*)::int count from current_issues group by issue_type,severity order by count desc`)).rows;
}

export async function getIssues(db, { limit = 100, issue_type = '', severity = '' } = {}) {
  const where = ['true']; const vals = [];
  if (issue_type) { vals.push(issue_type); where.push(`issue_type=$${vals.length}`); }
  if (severity) { vals.push(severity); where.push(`severity=$${vals.length}`); }
  vals.push(Math.min(Number(limit) || 100, 500));
  return (await db.query(`${currentIssuesCte()} select severity,issue_type,message,source_file_id,source_row,created_at from current_issues where ${where.join(' and ')} order by case severity when 'error' then 1 when 'warn' then 2 else 3 end,created_at desc limit $${vals.length}`, vals)).rows;
}

export async function getHealth(db, limit = 100) {
  const row=(await db.query(`${currentIssuesCte()}
    select
      (select coalesce(jsonb_agg(item),'[]'::jsonb) from (select severity,issue_type,message,source_file_id,source_row,created_at
        from current_issues order by case severity when 'error' then 1 when 'warn' then 2 else 3 end,created_at desc limit $1) item) issues,
      (select coalesce(jsonb_agg(item),'[]'::jsonb) from (select issue_type,severity,count(*)::int count
        from current_issues group by issue_type,severity order by count desc) item) summary,
      (select coalesce(jsonb_agg(item),'[]'::jsonb) from (select run_type,status,started_at,finished_at,duration_ms,rows_read,rows_written,error
        from sync_runs order by started_at desc limit 30) item) runs,
      (select count(*)::int from ${REPORTING_POSTS}) "totalRows",
      (select count(*)::int from ${REPORTING_POSTS} where posted_date is null) "missingDate",
      (select count(*)::int from ${REPORTING_POSTS} where coalesce(post_url,'')='') "missingLink",
      (select count(*)::int from ${REPORTING_POSTS} where coalesce(realtime_view,0)=0 and ${interactionsSql(REPORTING_POSTS)}=0) "missingMetrics",
      (select max(updated_at) from ${REPORTING_POSTS}) "mirrorUpdatedAt"`,[limit])).rows[0];
  return row;
}
