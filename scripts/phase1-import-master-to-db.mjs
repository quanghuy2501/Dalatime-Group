import path from 'path';
import { connectDb, runSqlFile, upsert } from '../src/db/postgres.mjs';
import { loadLiveMasterSnapshot, mapClient, mapStaff, mapBrand, mapChannel, mapPostRaw, mapPostBrandsFromRaw, mapBonusRules } from '../src/importers/liveMaster.mjs';

const root = process.cwd();
const dryRun = process.argv.includes('--dry-run');
const migrate = process.argv.includes('--migrate');
function cleanRows(rows, key) { return rows.filter(r => r[key]); }

function jsonb(row, keys = ['raw_row','raw_values','meta']) {
  for (const k of keys) if (k in row && row[k] !== null && row[k] !== undefined && typeof row[k] !== 'string') row[k] = JSON.stringify(row[k]);
  return row;
}
function jsonbAll(rows) { return rows.map(r => jsonb(r)); }

function dedupeBy(rows, keys) {
  const map = new Map();
  const passthrough = [];
  for (const row of rows) {
    const vals = keys.map(k => row[k]);
    if (vals.some(v => v === null || v === undefined || String(v).trim() === '')) {
      passthrough.push(row);
      continue;
    }
    map.set(vals.join('||'), row);
  }
  return [...passthrough, ...map.values()];
}

const snap = await loadLiveMasterSnapshot();
const clients = jsonbAll(cleanRows(snap.clients.map(mapClient), 'name')); 
const staff = jsonbAll(cleanRows(snap.staff.map(mapStaff), 'name')); 
const brands = jsonbAll(cleanRows(snap.brands.map(mapBrand), 'name')); 
const channels = jsonbAll(cleanRows(snap.channels.map(mapChannel), 'name')); 
const posts = jsonbAll(snap.rawRows.map(mapPostRaw).filter(p => p.posted_date || p.post_url));
const postBrands = posts.flatMap(mapPostBrandsFromRaw);
const bonusRules = mapBonusRules(snap.configRows);
const summary = { generatedAt: new Date().toISOString(), serviceAccountEmail: snap.serviceAccountEmail, dryRun, counts: { clients: clients.length, staff: staff.length, staff_inactive: staff.filter(row => !row.active).length, brands: brands.length, channels: channels.length, posts_raw: posts.length, post_brands: postBrands.length, bonus_rules: bonusRules.length } };
console.log(JSON.stringify(summary, null, 2));
if (dryRun) process.exit(0);
const db = await connectDb();
let runId = null;
try {
  await db.query('begin');
  const runRes = await db.query(`insert into sync_runs (run_type, status, started_at, rows_read, meta) values ('phase1_master_import', 'running', now(), $1, $2) returning id`, [summary.counts.posts_raw, JSON.stringify({dryRun:false, counts: summary.counts, serviceAccountEmail: summary.serviceAccountEmail})]);
  runId = runRes.rows[0].id;
  if (migrate) await runSqlFile(db, path.join(root, 'migrations', '001_initial_schema.sql'));
    await runSqlFile(db, path.join(root, 'migrations', '002_bonus_rules_and_quality.sql'));
  await upsert(db, 'clients', dedupeBy(clients, ['client_code']), ['client_code'], ['name','status','contact_name','report_file_id','raw_row','active']);
  await upsert(db, 'staff', dedupeBy(staff, ['nv_id']), ['nv_id'], ['name','role','channels_count','report_file_id','raw_row','active']);
  await upsert(db, 'brands', dedupeBy(brands, ['name']), ['name'], ['brand_code','client_code','client_name','group_name','status','raw_row','active']);
  await upsert(db, 'channels', dedupeBy(channels, ['name']), ['name'], ['channel_code','username','url','owner_name','follower','raw_row','active']);
  await upsert(db, 'posts_raw', dedupeBy(posts, ['dedupe_key']), ['dedupe_key'], ['source_file_id','source_row','posted_date','raw_posted_date','posted_date_parse_ok','brand_text_raw','channel_name','post_url','owner_name','is_exclusive','viral_label','realtime_view','realtime_like','realtime_comment','realtime_save','realtime_share','snapshot_view','snapshot_like','snapshot_comment','snapshot_save','snapshot_share','engagement_rate','status','bonus_amount','show_channel','viral_confirm_date','source_hash','raw_values']);
  // insert post_brands via dedupe lookup
  // bonus_results.rule_id references bonus_rules.id. Rebuild both inside this
  // transaction so re-imports are FK-safe and a failure restores the old data.
  await db.query('delete from bonus_results');
  await db.query('delete from bonus_rules');
  if (bonusRules.length) {
    const vals = [];
    const placeholders = bonusRules.map((r, i) => { vals.push(r.min_snapshot_view, r.max_snapshot_view, r.amount, r.amount_fulltime, r.amount_parttime, r.raw_source); return `($${i*6+1}, $${i*6+2}, $${i*6+3}, $${i*6+4}, $${i*6+5}, $${i*6+6})`; }).join(',');
    await db.query(`insert into bonus_rules (min_snapshot_view, max_snapshot_view, amount, amount_fulltime, amount_parttime, raw_source) values ${placeholders}`, vals);
  }
  await db.query(`insert into bonus_results (post_raw_id, eligible, reason, amount, rule_id)
    select p.id,
      case when p.viral_label <> '' and p.posted_date is not null and p.posted_date <= current_date - interval '14 days' and coalesce(p.snapshot_view,0) > 0 and br.id is not null then true else false end,
      case
        when coalesce(p.viral_label,'') = '' then 'not_viral'
        when p.posted_date is null then 'bad_or_missing_posted_date'
        when p.posted_date > current_date - interval '14 days' then 'waiting_14_days'
        when coalesce(p.snapshot_view,0) = 0 then 'missing_snapshot'
        when br.id is null then 'no_matching_bonus_rule'
        else 'eligible'
      end,
      case
        when p.viral_label <> '' and p.posted_date is not null and p.posted_date <= current_date - interval '14 days' and coalesce(p.snapshot_view,0) > 0 and br.id is not null
        then case when lower(coalesce(s.role,'')) like '%part%' then br.amount_parttime else br.amount_fulltime end
        else 0
      end,
      br.id
    from posts_raw p
    left join lateral (
      select role from staff st where st.active and lower(trim(st.name)) = lower(trim(p.owner_name)) order by st.updated_at desc limit 1
    ) s on true
    left join lateral (
      select * from bonus_rules b where b.min_snapshot_view <= coalesce(p.snapshot_view,0) order by b.min_snapshot_view desc limit 1
    ) br on true`);
  await db.query('delete from post_brands');
  await db.query('create temp table tmp_post_brands (post_dedupe_key text, brand_name text, source_brand_text text) on commit drop');
  const tmpRows = postBrands.map(pb => ({ post_dedupe_key: pb.post_dedupe_key, brand_name: pb.brand_name, source_brand_text: pb.source_brand_text }));
  await upsert(db, 'tmp_post_brands', tmpRows, ['post_dedupe_key','brand_name'], ['source_brand_text'], { maxParams: 50000, noUpdatedAt: true, plainInsert: true });
  await db.query(`insert into post_brands (post_raw_id, brand_name, source_brand_text, posted_date, channel_name, owner_name, post_url, realtime_view, realtime_like, realtime_comment, realtime_save, realtime_share, viral_label, bonus_amount)
    select p.id, t.brand_name, t.source_brand_text, p.posted_date, p.channel_name, p.owner_name, p.post_url, p.realtime_view, p.realtime_like, p.realtime_comment, p.realtime_save, p.realtime_share, p.viral_label, p.bonus_amount
    from tmp_post_brands t
    join posts_raw p on p.dedupe_key = t.post_dedupe_key
    on conflict (post_raw_id, brand_name) do nothing`);
  await db.query(`update sync_runs set status='ok', finished_at=now(), rows_written=$2, meta=$3 where id=$1`, [runId, summary.counts.posts_raw + summary.counts.post_brands, JSON.stringify({counts: summary.counts})]);
  await db.query('commit');
} catch (e) { await db.query('rollback'); throw e; } finally { await db.end(); }
console.log('IMPORT_OK');
