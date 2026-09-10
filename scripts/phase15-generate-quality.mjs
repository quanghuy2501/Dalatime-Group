import fs from 'fs';
import { connectDb } from '../src/db/postgres.mjs';

const db = await connectDb();
const started = Date.now();
await db.query('begin');
try {
  const run = await db.query(`insert into sync_runs (run_type, status, started_at, rows_read, rows_written, meta)
    values ('phase1_5_quality_check', 'running', now(), 0, 0, $1) returning id`, [JSON.stringify({source:'scripts/phase15-generate-quality.mjs'})]);
  const runId = run.rows[0].id;
  await db.query('delete from data_quality_issues where sync_run_id = $1', [runId]);
  const inserts = [];
  function add(severity, issue_type, source_file_id, source_row, post_raw_id, message) {
    inserts.push({severity, issue_type, source_file_id, source_row, post_raw_id, message});
  }
  const badDates = await db.query(`select id, source_file_id, source_row, raw_posted_date, post_url from posts_raw where posted_date_parse_ok=false or posted_date is null`);
  for (const r of badDates.rows) add('error','bad_or_missing_posted_date',r.source_file_id,r.source_row,r.id,`Ngày đăng không parse được: ${r.raw_posted_date || '(trống)'}`);
  const missingUrls = await db.query(`select id, source_file_id, source_row, posted_date, channel_name, owner_name from posts_raw where coalesce(post_url,'')=''`);
  for (const r of missingUrls.rows) add('warn','missing_post_url',r.source_file_id,r.source_row,r.id,`Thiếu link bài đăng: ${r.posted_date || ''} / ${r.channel_name || ''} / ${r.owner_name || ''}`);
  const brandMismatch = await db.query(`select distinct pb.brand_name, min(pb.post_url) sample_url, count(*)::int count from post_brands pb left join brands b on lower(trim(b.name))=lower(trim(pb.brand_name)) where b.id is null and pb.brand_name <> '(Chưa tag brand)' group by pb.brand_name order by count desc, pb.brand_name limit 1000`);
  for (const r of brandMismatch.rows) add('warn','brand_not_in_master',null,null,null,`Brand không khớp master: ${r.brand_name} (${r.count} dòng). Sample: ${r.sample_url || ''}`);
  const channelMismatch = await db.query(`select p.channel_name, count(*)::int count from posts_raw p left join channels c on lower(trim(c.name))=lower(trim(p.channel_name)) where coalesce(p.channel_name,'')<>'' and c.id is null group by p.channel_name order by count desc limit 1000`);
  for (const r of channelMismatch.rows) add('warn','channel_not_in_master',null,null,null,`Kênh không khớp master: ${r.channel_name} (${r.count} bài)`);
  const staffMismatch = await db.query(`select p.owner_name, count(*)::int count from posts_raw p left join staff s on lower(trim(s.name))=lower(trim(p.owner_name)) where coalesce(p.owner_name,'')<>'' and s.id is null group by p.owner_name order by count desc limit 1000`);
  for (const r of staffMismatch.rows) add('warn','staff_not_in_master',null,null,null,`Nhân sự không khớp master: ${r.owner_name} (${r.count} bài)`);
  const missingSnapshot = await db.query(`select id, source_file_id, source_row, posted_date, post_url from posts_raw where viral_label <> '' and posted_date is not null and posted_date <= current_date - interval '14 days' and coalesce(snapshot_view,0)=0`);
  for (const r of missingSnapshot.rows) add('warn','viral_missing_snapshot_after_14d',r.source_file_id,r.source_row,r.id,`Bài viral đủ 14 ngày nhưng thiếu snapshot view: ${r.post_url || ''}`);
  const duplicateUrl = await db.query(`select post_url, count(*)::int count from posts_raw where coalesce(post_url,'')<>'' group by post_url having count(*) > 1 order by count desc limit 1000`);
  for (const r of duplicateUrl.rows) add('info','duplicate_post_url_after_dedupe',null,null,null,`Link bài xuất hiện nhiều lần trước/sau dedupe logic: ${r.count} - ${r.post_url}`);

  for (let i=0; i<inserts.length; i+=500) {
    const chunk=inserts.slice(i,i+500); const vals=[];
    const ph=chunk.map((r,idx)=>{ vals.push(runId,r.severity,r.issue_type,r.source_file_id,r.source_row,r.post_raw_id,r.message); const n=idx*7; return `($${n+1},$${n+2},$${n+3},$${n+4},$${n+5},$${n+6},$${n+7})`; }).join(',');
    await db.query(`insert into data_quality_issues (sync_run_id,severity,issue_type,source_file_id,source_row,post_raw_id,message) values ${ph}`, vals);
  }
  await db.query(`update sync_runs set status='ok', finished_at=now(), duration_ms=$2, rows_written=$3, meta=$4 where id=$1`, [runId, Date.now()-started, inserts.length, JSON.stringify({issue_count:inserts.length})]);
  await db.query('commit');
} catch (e) { await db.query('rollback'); throw e; }

const summary={generatedAt:new Date().toISOString()};
summary.counts=(await db.query(`select issue_type, severity, count(*)::int count from data_quality_issues group by issue_type, severity order by count desc`)).rows;
summary.total=summary.counts.reduce((a,b)=>a+b.count,0);
summary.bonusRules=(await db.query(`select min_snapshot_view, amount_fulltime, amount_parttime from bonus_rules order by min_snapshot_view`)).rows;
fs.mkdirSync('reports/phase15',{recursive:true});
fs.writeFileSync('reports/phase15/data-quality-summary.json', JSON.stringify(summary,null,2));
const md=['# Phase 1.5 Data Quality Summary','',`Generated: ${summary.generatedAt}`,'',`Total issues: ${summary.total}`,'','## Issues by type',...summary.counts.map(r=>`- ${r.severity} / ${r.issue_type}: ${r.count}`),'','## Bonus rules',...summary.bonusRules.map(r=>`- >= ${Number(r.min_snapshot_view).toLocaleString('vi-VN')}: fulltime ${Number(r.amount_fulltime).toLocaleString('vi-VN')}đ, partime ${Number(r.amount_parttime).toLocaleString('vi-VN')}đ`)];
fs.writeFileSync('reports/phase15/data-quality-summary.md', md.join('\n'));
console.log(JSON.stringify(summary,null,2));
await db.end();
