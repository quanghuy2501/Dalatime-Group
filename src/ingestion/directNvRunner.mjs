import crypto from 'node:crypto';
import { connectDb, upsert } from '../db/postgres.mjs';
import { COLUMN_MAPPING, collectNvRows, createReadonlyApi, discoverSources, splitBrands, validateMapping } from './directNv.mjs';

const json = value => JSON.stringify(value);

async function activeConfig(db) {
  const result = await db.query(`select c.version,c.mapping from nv_config_versions c join sync_runs r on r.id=c.master_sync_run_id
    where c.active=true and r.status='ok' and r.run_type like '%master%' order by c.created_at desc limit 2`);
  if (result.rows.length !== 1) throw new Error('exactly one active config_version from a successful Master sync is required');
  const configured=result.rows[0].mapping;
  validateMapping(configured);
  if (JSON.stringify(configured)!==JSON.stringify(COLUMN_MAPPING)) throw new Error('active Master config mapping does not match the required exact 22-column mapping');
  return result.rows[0];
}

async function checkpoint(db, runId, { source,nextRow,rowsRead,status,error=null }) {
  await db.query(`insert into nv_ingestion_checkpoints(run_id,nv_id,google_file_id,sheet_name,next_row,rows_read,status,error)
    values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(run_id,google_file_id,sheet_name) do update set
    next_row=excluded.next_row,rows_read=excluded.rows_read,status=excluded.status,error=excluded.error,updated_at=now()`,
  [runId,source.nv_id,source.google_file_id,source.sheet_name,nextRow,rowsRead,status,error]);
}

function mirrorRows(rows, runId) {
  return rows.map(({mapped_row}) => ({ ...mapped_row, raw_values:json(mapped_row.raw_values), published_run_id:runId }));
}

function brandRows(rows, runId) {
  return rows.flatMap(({mapped_row}) => splitBrands(mapped_row.brand_text_raw).map(brand => ({ raw_sheet_row_key:mapped_row.row_key,
    brand_name:brand, source_brand_text:mapped_row.brand_text_raw, posted_date:mapped_row.posted_date, channel_name:mapped_row.channel_name,
    owner_name:mapped_row.owner_name, post_url:mapped_row.post_url, realtime_view:mapped_row.realtime_view,
    realtime_like:mapped_row.realtime_like, realtime_comment:mapped_row.realtime_comment, realtime_save:mapped_row.realtime_save,
    realtime_share:mapped_row.realtime_share, viral_label:mapped_row.viral_label, bonus_amount:mapped_row.bonus_amount, published_run_id:runId })));
}

export async function publishNvRows(db, runId, configVersion, rows, sourceCount) {
  const raw=mirrorRows(rows,runId), brands=brandRows(rows,runId);
  const fingerprint=crypto.createHash('sha256').update(rows.map(r=>`${r.row_key}:${r.source_hash}`).sort().join('\n')).digest('hex');
  await db.query('begin');
  try {
    await db.query(`select pg_advisory_xact_lock(hashtext('onicorn:direct-nv-publish'))`);
    const gate=(await db.query(`select count(*)::int total,count(*) filter(where status='ok')::int ok from nv_ingestion_checkpoints where run_id=$1`,[runId])).rows[0];
    if (Number(gate.total)!==sourceCount || Number(gate.ok)!==sourceCount) throw new Error('source checkpoint gate failed');
    await db.query('delete from post_brands_sheet'); await db.query('delete from posts_raw_sheet');
    await upsert(db,'posts_raw_sheet',raw,['row_key'],Object.keys(raw[0]||{}).filter(k=>!['row_key'].includes(k)),{maxParams:30000});
    await upsert(db,'post_brands_sheet',brands,['raw_sheet_row_key','brand_name'],Object.keys(brands[0]||{}).filter(k=>!['raw_sheet_row_key','brand_name'].includes(k)),{maxParams:30000});
    const counts=(await db.query(`select (select count(*) from posts_raw_sheet where published_run_id=$1)::int raw,
      (select count(*) from nv_posts_staging where run_id=$1)::int staged`,[runId])).rows[0];
    if (Number(counts.raw)!==rows.length || Number(counts.staged)!==rows.length) throw new Error('in-transaction publication parity failed');
    await db.query(`insert into nv_published_snapshots(singleton,run_id,config_version,row_count,fingerprint) values(true,$1,$2,$3,$4)
      on conflict(singleton) do update set run_id=excluded.run_id,config_version=excluded.config_version,row_count=excluded.row_count,fingerprint=excluded.fingerprint,published_at=now()`,
      [runId,configVersion,rows.length,fingerprint]);
    await db.query(`update sync_runs set status='ok',finished_at=now(),duration_ms=extract(epoch from(now()-started_at))*1000,
      rows_read=$2,rows_written=$2,files_total=$3,files_ok=$3 where id=$1`,[runId,rows.length,sourceCount]);
    await db.query('commit');
    return {runId,rows:rows.length,brands:brands.length,fingerprint,configVersion};
  } catch (error) { await db.query('rollback'); throw error; }
}

export async function runDirectNvIngestion({ db,api,registryFile,concurrency=Number(process.env.NV_CONCURRENCY||3),pageRows=Number(process.env.NV_PAGE_ROWS||500),publisher=publishNvRows }={}) {
  db ||= await connectDb(); let runId; let ownDb=!arguments[0]?.db;
  try {
    const config=await activeConfig(db); const sources=await discoverSources(db,registryFile);
    if (!sources.length) throw new Error('active NV source registry contains zero sources');
    const expectedRaw=process.env.NV_EXPECTED_ACTIVE_COUNT;
    if (expectedRaw !== undefined && (!/^\d+$/.test(expectedRaw) || Number(expectedRaw) !== sources.length)) {
      throw new Error(`active NV source count does not match NV_EXPECTED_ACTIVE_COUNT; expected ${expectedRaw}, got ${sources.length}`);
    }
    runId=(await db.query(`insert into sync_runs(run_type,status,files_total,meta) values('direct_nv_ingestion','running',$1,$2) returning id`,
      [sources.length,json({read_only_google:true,config_version:config.version,source:'employee-sheets',master_as_data:false})])).rows[0].id;
    api ||= await createReadonlyApi();
    const rows=await collectNvRows({api,sources,configVersion:config.version,concurrency,pageRows,checkpoint:event=>checkpoint(db,runId,event)});
    if (!rows.length) throw new Error('validation failed: active NV sources produced zero rows');
    await db.query('begin');
    try {
      await upsert(db,'nv_posts_staging',rows.map(r=>({...r,run_id:runId,mapped_row:json(r.mapped_row)})),['run_id','row_key'],['source_hash'],{noUpdatedAt:true,maxParams:30000});
      await db.query('commit');
    } catch(error) { await db.query('rollback'); throw error; }
    return await publisher(db,runId,config.version,rows,sources.length);
  } catch(error) {
    if(runId) await db.query(`update sync_runs set status='fail',finished_at=now(),duration_ms=extract(epoch from(now()-started_at))*1000,error=$2 where id=$1`,[runId,String(error.message).slice(0,2000)]).catch(()=>{});
    throw error;
  } finally { if(ownDb) await db.end(); }
}
