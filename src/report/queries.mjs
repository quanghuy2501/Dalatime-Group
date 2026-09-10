function addFilters(where, vals, params, alias = 'p') {
  if (params.from) { vals.push(params.from); where.push(`${alias}.posted_date >= $${vals.length}`); }
  if (params.to) { vals.push(params.to); where.push(`${alias}.posted_date <= $${vals.length}`); }
  if (params.brand) { vals.push(params.brand); where.push(`exists (select 1 from post_brands_sheet pbf where pbf.raw_sheet_row_key=${alias}.row_key and lower(trim(pbf.brand_name))=lower(trim($${vals.length})))`); }
  if (params.channel) { vals.push(params.channel); where.push(`${alias}.channel_name = $${vals.length}`); }
}

function dedupedSource() {
  // Customer reports must show one row per post URL. The exact mirror remains
  // unchanged for admin parity; only this read-only portal scope is deduped.
  return `(select distinct on (case when nullif(trim(post_url), '') is null then row_key else regexp_replace(regexp_replace(lower(trim(post_url)), '\\?.*$', ''), '/$', '') end) *
    from posts_raw_sheet
    where exists (select 1 from post_brands_sheet pb0
      join brands b0 on lower(trim(b0.name))=lower(trim(pb0.brand_name))
      where pb0.raw_sheet_row_key=posts_raw_sheet.row_key and b0.active=true and b0.client_code=$1)
    order by case when nullif(trim(post_url), '') is null then row_key else regexp_replace(regexp_replace(lower(trim(post_url)), '\\?.*$', ''), '/$', '') end,
      updated_at desc nulls last, row_key desc) p`;
}

function scoped(clientCode, params = {}) {
  const vals = [clientCode];
  const where = [`exists (
    select 1 from post_brands_sheet pb
    join brands b on lower(trim(b.name))=lower(trim(pb.brand_name))
    where pb.raw_sheet_row_key=p.row_key and b.active=true and b.client_code=$1
  )`];
  addFilters(where, vals, params);
  return { vals, whereSql: where.join(' and ') };
}

export async function getReportScope(db, clientCode) {
  const client = (await db.query(`select name from clients where client_code=$1 and active=true limit 1`, [clientCode])).rows[0];
  if (!client) return null;
  const brands = (await db.query(`select distinct b.name
    from brands b where b.client_code=$1 and b.active=true order by b.name`, [clientCode])).rows.map(row => row.name);
  const channels = (await db.query(`select distinct p.channel_name as name from posts_raw_sheet p
    where p.channel_name is not null and p.channel_name <> '' and exists (
      select 1 from post_brands_sheet pb join brands b on lower(trim(b.name))=lower(trim(pb.brand_name))
      where pb.raw_sheet_row_key=p.row_key and b.active=true and b.client_code=$1
    ) order by name`, [clientCode])).rows.map(row => row.name);
  return { customerName: client.name, brands, channels };
}

export async function getReportStatus(db, clientCode, scope) {
  const sync = (await db.query(`select finished_at from sync_runs
    where status in ('ok','partial') and finished_at is not null order by finished_at desc limit 1`)).rows[0];
  return { ok: true, customerName: scope.customerName, brands: scope.brands, channels: scope.channels, lastSyncAt: sync?.finished_at || null };
}

export async function getReportOverview(db, clientCode, params = {}) {
  const { vals, whereSql } = scoped(clientCode, params);
  return (await db.query(`select count(*)::int as posts,
    coalesce(sum(p.realtime_view),0)::bigint as view,
    coalesce(sum(p.realtime_like),0)::bigint as likes,
    coalesce(sum(p.realtime_comment),0)::bigint as comments,
    coalesce(sum(p.realtime_save),0)::bigint as saves,
    coalesce(sum(p.realtime_share),0)::bigint as shares,
    coalesce(sum(coalesce(p.realtime_like,0)+coalesce(p.realtime_comment,0)+coalesce(p.realtime_save,0)+coalesce(p.realtime_share,0)),0)::bigint as interactions,
    case when coalesce(sum(p.realtime_view),0)>0 then sum(coalesce(p.realtime_like,0)+coalesce(p.realtime_comment,0)+coalesce(p.realtime_save,0)+coalesce(p.realtime_share,0))::numeric/sum(p.realtime_view)*100 else 0 end as er,
    count(*) filter (where coalesce(p.viral_label,'')<>'')::int as viral,
    count(*) filter (where coalesce(p.is_exclusive,false))::int as exclusive,
    min(p.posted_date)::date as date_from,
    max(p.posted_date)::date as date_to,
    count(distinct nullif(p.channel_name,''))::int as active_channels
    from ${dedupedSource()} where ${whereSql}`, vals)).rows[0];
}

export async function getReportTimeseries(db, clientCode, params = {}) {
  const { vals, whereSql } = scoped(clientCode, params);
  return (await db.query(`select p.posted_date::date as date, count(*)::int as posts,
    coalesce(sum(p.realtime_view),0)::bigint as view,
    coalesce(sum(p.realtime_like+p.realtime_comment+p.realtime_save+p.realtime_share),0)::bigint as interactions
    from ${dedupedSource()} where p.posted_date is not null and ${whereSql}
    group by p.posted_date::date order by date`, vals)).rows;
}

export async function getReportPosts(db, clientCode, params = {}) {
  const { vals, whereSql } = scoped(clientCode, params);
  const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 100);
  const offset = Math.max(Number(params.offset) || 0, 0);
  const countVals = vals.slice();
  vals.push(limit, offset);
  const rows = db.query(`select p.posted_date, (select string_agg(distinct pbl.brand_name, ', ' order by pbl.brand_name)
      from post_brands_sheet pbl join brands bl on lower(trim(bl.name))=lower(trim(pbl.brand_name))
      where pbl.raw_sheet_row_key=p.row_key and bl.active=true and bl.client_code=$1) as brand_names,
    p.channel_name, p.post_url,
    p.realtime_view, p.realtime_like, p.realtime_comment, p.realtime_save, p.realtime_share,
    p.engagement_rate, p.is_exclusive, p.viral_label
    from ${dedupedSource()} where ${whereSql}
    order by p.posted_date desc nulls last, p.realtime_view desc limit $${vals.length - 1} offset $${vals.length}`, vals);
  const count = db.query(`select count(*)::int as count from ${dedupedSource()} where ${whereSql}`, countVals);
  const [rowResult, countResult] = await Promise.all([rows, count]);
  return { rows: rowResult.rows, total: countResult.rows[0].count, limit, offset };
}
