import path from 'path';
import { connectDb, runSqlFile, upsert } from '../src/db/postgres.mjs';
import { loadLiveMasterSnapshot, mapPostRaw, mapPostBrandsFromRaw } from '../src/importers/liveMaster.mjs';
import { sha256 } from '../src/utils/normalize.mjs';
function jsonb(row){ if(row.raw_values && typeof row.raw_values !== 'string') row.raw_values=JSON.stringify(row.raw_values); return row; }
const snap=await loadLiveMasterSnapshot();
const raw=snap.rawRows.map((o,idx)=>{
 const p=mapPostRaw(o); p.row_key=sha256(`${p.source_file_id||''}|${p.source_row||idx}|${p.source_hash}`); delete p.dedupe_key; return jsonb(p);
}).filter(p=>p.posted_date||p.post_url||p.brand_text_raw||p.channel_name);
const brandRows=[];
for (const p of raw) for (const b of mapPostBrandsFromRaw(p)) brandRows.push({raw_sheet_row_key:p.row_key,brand_name:b.brand_name,source_brand_text:b.source_brand_text,posted_date:p.posted_date,channel_name:p.channel_name,owner_name:p.owner_name,post_url:p.post_url,realtime_view:p.realtime_view,realtime_like:p.realtime_like,realtime_comment:p.realtime_comment,realtime_save:p.realtime_save,realtime_share:p.realtime_share,viral_label:p.viral_label,bonus_amount:p.bonus_amount});
const db=await connectDb();
await db.query('begin');
try{
 await runSqlFile(db,path.join(process.cwd(),'migrations/004_exact_sheet_mirror.sql'));
 const run=(await db.query(`insert into sync_runs(run_type,status,started_at,rows_read,meta) values('phase2_2_exact_sheet_mirror','running',now(),$1,$2) returning id`,[raw.length,JSON.stringify({post_brand_rows:brandRows.length})])).rows[0];
 await db.query('delete from post_brands_sheet'); await db.query('delete from posts_raw_sheet');
 await upsert(db,'posts_raw_sheet',raw,['row_key'],Object.keys(raw[0]).filter(k=>!['id','row_key','created_at'].includes(k)),{maxParams:50000});
 await upsert(db,'post_brands_sheet',brandRows,['raw_sheet_row_key','brand_name'],Object.keys(brandRows[0]).filter(k=>!['id','raw_sheet_row_key','brand_name'].includes(k)),{maxParams:50000,noUpdatedAt:true});
 await db.query(`update sync_runs set status='ok',finished_at=now(),rows_written=$2,meta=$3 where id=$1`,[run.id,raw.length+brandRows.length,JSON.stringify({raw_rows:raw.length,brand_rows:brandRows.length})]);
 await db.query('commit');
 console.log(JSON.stringify({raw_rows:raw.length,brand_rows:brandRows.length},null,2));
}catch(e){await db.query('rollback'); throw e} finally {await db.end()}
