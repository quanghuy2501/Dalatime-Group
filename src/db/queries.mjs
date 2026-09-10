function rangeWhere(alias, params = {}) {
  const where = [];
  const vals = [];
  const col = `${alias}.posted_date`;
  if (params.from) { vals.push(params.from); where.push(`${col} >= $${vals.length}`); }
  if (params.to) { vals.push(params.to); where.push(`${col} <= $${vals.length}`); }
  return { where, vals };
}

const interactionsSql = alias => `coalesce(${alias}.realtime_like,0)+coalesce(${alias}.realtime_comment,0)+coalesce(${alias}.realtime_save,0)+coalesce(${alias}.realtime_share,0)`;

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
    case when coalesce(sum(p.realtime_view),0)>0 then sum(${interactionsSql('p')})::numeric / sum(p.realtime_view) * 100 else 0 end as er,
    count(*) filter (where coalesce(p.viral_label,'') <> '')::int as viral,
    count(*) filter (where p.is_exclusive)::int as exclusive,
    count(distinct nullif(p.channel_name,''))::int as active_channels,
    count(distinct nullif(p.owner_name,''))::int as active_staff,
    count(*) filter (where p.posted_date >= current_date - interval '7 days')::int as posts_7d,
    coalesce(sum(p.realtime_view) filter (where p.posted_date >= current_date - interval '7 days'),0)::bigint as view_7d
    from posts_raw_sheet p ${where.length ? 'where ' + where.join(' and ') : ''}`;
  return (await db.query(sql, vals)).rows[0];
}

async function grouped(db, table, alias, keySql, params, limit = 50) {
  const { where, vals } = rangeWhere(alias, params);
  vals.push(limit); const limitParam = `$${vals.length}`;
  const sql = `select ${keySql} as name,
    count(*)::int as posts,
    coalesce(sum(${alias}.realtime_view),0)::bigint as view,
    coalesce(sum(${interactionsSql(alias)}),0)::bigint as interactions,
    case when coalesce(sum(${alias}.realtime_view),0)>0 then sum(${interactionsSql(alias)})::numeric / sum(${alias}.realtime_view) * 100 else 0 end as er,
    count(*) filter (where coalesce(${alias}.viral_label,'') <> '')::int as viral,
    max(${alias}.posted_date) as last_posted_date
    from ${table} ${alias}
    ${where.length ? 'where ' + where.join(' and ') : ''}
    group by ${keySql}
    order by view desc nulls last limit ${limitParam}`;
  return (await db.query(sql, vals)).rows;
}

export async function getTopBrands(db, limit = 50, params = {}) {
  const rows = await grouped(db, 'post_brands_sheet', 'pb', 'pb.brand_name', params, limit);
  return rows.map(r => ({ brand_name: r.name, ...r }));
}

export async function getTopStaff(db, limit = 50, params = {}) {
  const { where, vals } = rangeWhere('p', params);
  vals.push(limit); const limitParam = `$${vals.length}`;
  const sql = `select coalesce(nullif(p.owner_name,''),'(Chưa gán)') as staff_name,
    count(*)::int as posts, coalesce(sum(p.realtime_view),0)::bigint as view,
    coalesce(sum(${interactionsSql('p')}),0)::bigint as interactions,
    case when coalesce(sum(p.realtime_view),0)>0 then sum(${interactionsSql('p')})::numeric/sum(p.realtime_view)*100 else 0 end as er,
    count(*) filter (where coalesce(p.viral_label,'') <> '')::int as viral,
    coalesce(sum(p.bonus_amount),0)::bigint as bonus_amount,
    max(p.posted_date) as last_posted_date
    from posts_raw_sheet p 
    ${where.length ? 'where ' + where.join(' and ') : ''}
    group by coalesce(nullif(p.owner_name,''),'(Chưa gán)') order by view desc nulls last limit ${limitParam}`;
  return (await db.query(sql, vals)).rows;
}

export async function getTopChannels(db, limit = 50, params = {}) {
  const rows = await grouped(db, 'posts_raw_sheet', 'p', `coalesce(nullif(p.channel_name,''),'(Chưa gán)')`, params, limit);
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
      coalesce(sum(pb.realtime_view) filter (where pb.posted_date >= current_date-interval '7 days'),0)::bigint as view,
      coalesce(sum(pb.realtime_view) filter (where pb.posted_date >= current_date-interval '14 days' and pb.posted_date < current_date-interval '7 days'),0)::bigint as view_prev
      from post_brands_sheet pb group by pb.brand_name)
      select name,view,"view_prev" as "viewPrev",round((view-view_prev)::numeric/nullif(view_prev,0)*100,1) as change from stats
      where view_prev>100 and (view-view_prev)::numeric/view_prev < -.3 order by change limit 8`),
    db.query(`with stats as (select coalesce(nullif(owner_name,''),'(Chưa gán)') as name,
      coalesce(sum(realtime_view) filter (where posted_date >= current_date-interval '7 days'),0)::bigint as view,
      coalesce(sum(realtime_view) filter (where posted_date >= current_date-interval '14 days' and posted_date < current_date-interval '7 days'),0)::bigint as view_prev
      from posts_raw_sheet group by coalesce(nullif(owner_name,''),'(Chưa gán)'))
      select name,view,"view_prev" as "viewPrev",round((view-view_prev)::numeric/nullif(view_prev,0)*100,1) as change from stats
      where view_prev>100 and (view-view_prev)::numeric/view_prev < -.3 order by change limit 8`),
    db.query(`select c.name,c.owner_name as owner,
      coalesce((current_date-max(p.posted_date))::int,999) as "lastPostDays",max(p.posted_date)::date as "lastPostDate"
      from channels c left join posts_raw_sheet p on lower(trim(p.channel_name))=lower(trim(c.name))
      where c.active group by c.name,c.owner_name having max(p.posted_date) is null or max(p.posted_date)<current_date-interval '14 days'
      order by "lastPostDays" desc limit 20`),
    db.query(`select started_at as timestamp,run_type as job,status,error from sync_runs where status='fail' order by started_at desc limit 10`),
    db.query(`select posted_date as date,brand_text_raw as brand,channel_name as channel,owner_name as owner,realtime_view as view,post_url as link
      from posts_raw_sheet where posted_date>=current_date-interval '7 days' order by realtime_view desc nulls last limit 5`),
    db.query(`select coalesce(nullif(channel_name,''),'(Chưa gán)') as name,count(*)::int as viral from posts_raw_sheet
      where coalesce(viral_label,'')<>'' group by coalesce(nullif(channel_name,''),'(Chưa gán)') order by viral desc limit 5`)
  ]);
  return { brandsDrop: brandDrops.rows, staffDrop: staffDrops.rows, sleepingChannels: sleepingChannels.rows, failedSync: failedSync.rows, trending: trending.rows, topViralChannels: viralChannels.rows };
}

export async function getHeatmap(db, params = {}) {
  const { where, vals } = rangeWhere('pb', params);
  const filter = where.length ? `and ${where.join(' and ')}` : `and pb.posted_date>=current_date-interval '56 days'`;
  const rows = await db.query(`select pb.brand_name as brand,date_trunc('week',pb.posted_date)::date as week,
    coalesce(sum(pb.realtime_view),0)::bigint as view from post_brands_sheet pb
    where pb.posted_date is not null ${filter} group by pb.brand_name,date_trunc('week',pb.posted_date) order by week,view desc`, vals);
  return rows.rows;
}

export async function getQualitySummary(db) {
  return (await db.query('select * from v_quality_summary order by count desc')).rows;
}

export async function getPosts(db, { limit = 100, offset = 0, q = '', brand = '', channel = '', staff = '', from = '', to = '', sort = 'view', dir = 'desc' } = {}) {
  const sortMap = { date: 'p.posted_date', view: 'p.realtime_view', like: 'p.realtime_like', comment: 'p.realtime_comment', save: 'p.realtime_save', share: 'p.realtime_share', er: 'p.engagement_rate', viral: 'p.viral_label' };
  const sortSql = sortMap[sort] || sortMap.view;
  const dirSql = String(dir).toLowerCase() === 'asc' ? 'asc' : 'desc';
  const where = [];
  const vals = [];
  if (q) { vals.push(`%${q}%`); const p = `$${vals.length}`; where.push(`(p.brand_text_raw ilike ${p} or p.channel_name ilike ${p} or p.owner_name ilike ${p} or p.post_url ilike ${p})`); }
  if (brand) { vals.push(`%${brand}%`); where.push(`p.brand_text_raw ilike $${vals.length}`); }
  if (channel) { vals.push(channel); where.push(`p.channel_name = $${vals.length}`); }
  if (staff) { vals.push(staff); where.push(`p.owner_name = $${vals.length}`); }
  if (from) { vals.push(from); where.push(`p.posted_date >= $${vals.length}`); }
  if (to) { vals.push(to); where.push(`p.posted_date <= $${vals.length}`); }
  const countVals = vals.slice();
  vals.push(Math.min(Number(limit) || 100, 500)); const limitParam = `$${vals.length}`;
  vals.push(Math.max(Number(offset) || 0, 0)); const offsetParam = `$${vals.length}`;
  const whereSql = where.length ? 'where ' + where.join(' and ') : '';
  const sql = `select p.id, p.posted_date, p.brand_text_raw, p.channel_name, p.owner_name, p.post_url,
    p.realtime_view, p.realtime_like, p.realtime_comment, p.realtime_save, p.realtime_share,
    p.snapshot_view, p.viral_label, p.engagement_rate, p.bonus_amount, p.bonus_amount as calculated_bonus, null::text as bonus_reason
    from posts_raw_sheet p left join bonus_results br on br.post_raw_id = p.id
    ${whereSql} order by ${sortSql} ${dirSql} nulls last limit ${limitParam} offset ${offsetParam}`;
  const countSql = `select count(*)::int count from posts_raw_sheet p ${whereSql}`;
  const [rows, count] = await Promise.all([db.query(sql, vals), db.query(countSql, countVals)]);
  return { rows: rows.rows, total: count.rows[0].count, limit: Number(limit), offset: Number(offset) };
}

export async function getTimeseries(db, params = {}) {
  const { where, vals } = rangeWhere('p', params);
  const sql = `select p.posted_date::date as date,
    count(*)::int as posts,
    coalesce(sum(p.realtime_view),0)::bigint as view,
    coalesce(sum(${interactionsSql('p')}),0)::bigint as interactions,
    case when coalesce(sum(p.realtime_view),0)>0 then sum(${interactionsSql('p')})::numeric / sum(p.realtime_view) * 100 else 0 end as er,
    count(*) filter (where coalesce(p.viral_label,'') <> '')::int as viral
    from posts_raw_sheet p
    where p.posted_date is not null ${where.length ? 'and ' + where.join(' and ') : ''}
    group by p.posted_date::date
    order by date asc`;
  return (await db.query(sql, vals)).rows;
}

export async function getIssueTypes(db) {
  return (await db.query(`select issue_type, severity, count(*)::int count from data_quality_issues where fixed=false group by issue_type, severity order by count desc`)).rows;
}

export async function getIssues(db, { limit = 100, issue_type = '', severity = '' } = {}) {
  const where = ['fixed=false']; const vals = [];
  if (issue_type) { vals.push(issue_type); where.push(`issue_type=$${vals.length}`); }
  if (severity) { vals.push(severity); where.push(`severity=$${vals.length}`); }
  vals.push(Math.min(Number(limit) || 100, 500));
  return (await db.query(`select severity, issue_type, message, source_file_id, source_row, created_at from data_quality_issues where ${where.join(' and ')} order by case severity when 'error' then 1 when 'warn' then 2 else 3 end, created_at desc limit $${vals.length}`, vals)).rows;
}

export async function getHealth(db, limit = 100) {
  const issues = await db.query('select severity, issue_type, message, source_file_id, source_row, created_at from data_quality_issues where fixed=false order by case severity when \'error\' then 1 when \'warn\' then 2 else 3 end, created_at desc limit $1', [limit]);
  const runs = await db.query('select run_type,status,started_at,finished_at,duration_ms,rows_read,rows_written,error from sync_runs order by started_at desc limit 30');
  const mirror = await db.query(`select count(*)::int as "totalRows",
    count(*) filter (where posted_date is null)::int as "missingDate",
    count(*) filter (where coalesce(post_url,'')='')::int as "missingLink",
    count(*) filter (where coalesce(realtime_view,0)=0 and ${interactionsSql('posts_raw_sheet')}=0)::int as "missingMetrics",
    max(updated_at) as "mirrorUpdatedAt" from posts_raw_sheet`);
  return { issues: issues.rows, runs: runs.rows, summary: await getQualitySummary(db), ...mirror.rows[0] };
}
