import crypto from 'node:crypto';
import { connectDb, upsert } from '../db/postgres.mjs';
import { COLUMN_MAPPING, NvTimeoutError, collectNvRows, createReadonlyApi, discoverSources, splitBrands, validateMapping } from './directNv.mjs';

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

async function checkpoint(db, runId, { source,pageStart,pageEnd,page,nextRow,rowsRead,status,error=null }) {
  if(pageStart && pageEnd && page) await db.query(`insert into nv_ingestion_page_cache(run_id,nv_id,google_file_id,sheet_name,page_start,page_end,page_data)
    values($1,$2,$3,$4,$5,$6,$7) on conflict(run_id,google_file_id,sheet_name,page_start) do update set
    page_end=excluded.page_end,page_data=excluded.page_data,updated_at=now()`,
  [runId,source.nv_id,source.google_file_id,source.sheet_name,pageStart,pageEnd,json(page)]);
  await db.query(`insert into nv_ingestion_checkpoints(run_id,nv_id,google_file_id,sheet_name,next_row,rows_read,status,error)
    values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(run_id,google_file_id,sheet_name) do update set
    next_row=excluded.next_row,rows_read=excluded.rows_read,status=excluded.status,error=excluded.error,updated_at=now()`,
  [runId,source.nv_id,source.google_file_id,source.sheet_name,nextRow,rowsRead,status,error]);
}

const positiveInt=(value,fallback)=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):fallback;
const defaultLog=event=>console.log(json({timestamp:new Date().toISOString(),...event}));

async function resumablePages(db, configVersion) {
  const result=await db.query(`select p.google_file_id,p.sheet_name,p.page_start,p.page_end,p.page_data
    from nv_ingestion_page_cache p join sync_runs r on r.id=p.run_id
    where r.run_type='direct_nv_ingestion' and r.status='fail' and r.meta->>'config_version'=$1
      and p.run_id=(select r2.id from sync_runs r2 where r2.run_type='direct_nv_ingestion' and r2.status='fail'
        and r2.meta->>'config_version'=$1 order by r2.started_at desc limit 1)
    order by p.google_file_id,p.page_start`,[configVersion]);
  const bySource=new Map();
  for(const row of result.rows||[]) {
    const key=`${row.google_file_id}:${row.sheet_name}`;
    if(!bySource.has(key))bySource.set(key,new Map());
    bySource.get(key).set(`${row.page_start}:${row.page_end}`,typeof row.page_data==='string'?JSON.parse(row.page_data):row.page_data);
  }
  return bySource;
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

export async function publishNvRows(db, runId, configVersion, rows, sourceCount, {statementTimeoutMs=120000,diagnostics={}}={}) {
  const raw=mirrorRows(rows,runId), brands=brandRows(rows,runId);
  const fingerprint=crypto.createHash('sha256').update(rows.map(r=>`${r.row_key}:${r.source_hash}`).sort().join('\n')).digest('hex');
  await db.query('begin');
  try {
    await db.query(`select set_config('statement_timeout',$1,true)`,[String(Math.max(1,Math.floor(statementTimeoutMs)))]);
    await db.query(`select pg_advisory_xact_lock(hashtext('onicorn:direct-nv-publish'))`);
    const gate=(await db.query(`select count(*)::int total,count(*) filter(where status in ('ok','empty','fail'))::int terminal from nv_ingestion_checkpoints where run_id=$1`,[runId])).rows[0];
    if (Number(gate.total)!==sourceCount || Number(gate.terminal)!==sourceCount) throw new Error('source checkpoint gate failed');
    const freshSourceIds=diagnostics.fresh_source_ids||[];
    if (!freshSourceIds.length) throw new Error('no readable NV sources; last-known-good publication preserved');
    await db.query(`delete from post_brands_sheet b using posts_raw_sheet p where b.raw_sheet_row_key=p.row_key and p.source_file_id=any($1::text[])`,[freshSourceIds]);
    await db.query(`delete from posts_raw_sheet where source_file_id=any($1::text[])`,[freshSourceIds]);
    await upsert(db,'posts_raw_sheet',raw,['row_key'],Object.keys(raw[0]||{}).filter(k=>!['row_key'].includes(k)),{maxParams:30000});
    await upsert(db,'post_brands_sheet',brands,['raw_sheet_row_key','brand_name'],Object.keys(brands[0]||{}).filter(k=>!['raw_sheet_row_key','brand_name'].includes(k)),{maxParams:30000});
    const counts=(await db.query(`select (select count(*) from posts_raw_sheet where published_run_id=$1)::int raw,
      (select count(*) from posts_raw_sheet)::int total,(select count(*) from nv_posts_staging where run_id=$1)::int staged`,[runId])).rows[0];
    if (Number(counts.raw)!==rows.length || Number(counts.staged)!==rows.length) throw new Error('in-transaction publication parity failed');
    await db.query(`insert into nv_published_snapshots(singleton,run_id,config_version,row_count,fingerprint) values(true,$1,$2,$3,$4)
      on conflict(singleton) do update set run_id=excluded.run_id,config_version=excluded.config_version,row_count=excluded.row_count,fingerprint=excluded.fingerprint,published_at=now()`,
      [runId,configVersion,Number(counts.total),fingerprint]);
    const runStatus=diagnostics.failed?'partial':'ok';
    await db.query(`update sync_runs set status=$4,finished_at=now(),duration_ms=extract(epoch from(now()-started_at))*1000,
      rows_read=$2,rows_written=$2,files_total=$3,files_ok=$5,files_fail=$8,error=$6,meta=meta||$7::jsonb where id=$1`,
      [runId,rows.length,sourceCount,runStatus,sourceCount-(diagnostics.failed||0),diagnostics.failed?json(diagnostics.errors):null,
        json({partial:Boolean(diagnostics.failed),errors:diagnostics.errors||[],freshness:{fresh_source_ids:freshSourceIds,last_known_good_source_ids:(diagnostics.failed_sources||[]).map(x=>x.google_file_id)}}),diagnostics.failed||0]);
    await db.query('commit');
    return {runId,status:runStatus,rows:rows.length,totalRows:Number(counts.total),brands:brands.length,fingerprint,configVersion,diagnostics};
  } catch (error) { await db.query('rollback'); throw error; }
}

export async function runDirectNvIngestion({ db,api,registryFile,concurrency=Number(process.env.NV_CONCURRENCY||2),pageRows=Number(process.env.NV_PAGE_ROWS||500),
  pageTimeoutMs=positiveInt(process.env.NV_PAGE_TIMEOUT_MS,120000),sourceTimeoutMs=positiveInt(process.env.NV_SOURCE_TIMEOUT_MS,120000),
  totalTimeoutMs=positiveInt(process.env.NV_TOTAL_TIMEOUT_MS,1500000),heartbeatMs=positiveInt(process.env.NV_HEARTBEAT_MS,30000),
  sourceRetries=positiveInt(process.env.NV_SOURCE_RETRIES,1),publisher=publishNvRows,log=defaultLog }={}) {
  db ||= await connectDb(); let runId; let ownDb=!arguments[0]?.db;
  let dbQueue=Promise.resolve(); let heartbeat; const startedAt=Date.now(); let terminal=false; let locked=false;
  const deadlineAt=startedAt+totalTimeoutMs;
  const queued=fn=>{const next=dbQueue.then(fn);dbQueue=next.catch(()=>{});return next;};
  const progress=event=>log({job:'direct_nv_ingestion',runId,...event,elapsedMs:Date.now()-startedAt});
  const assertActive=()=>{if(Date.now()-startedAt>=totalTimeoutMs)throw new NvTimeoutError('direct NV total runtime',totalTimeoutMs);};
  try {
    const lockResult=await queued(()=>db.query(`select pg_try_advisory_lock(hashtext('onicorn:direct-nv-run')) locked`));
    if(lockResult.rows?.[0]?.locked===false)throw new Error('another direct NV run holds the scheduler lock');
    locked=true;
    await queued(()=>db.query(`update sync_runs set status='fail',finished_at=now(),duration_ms=extract(epoch from(now()-started_at))*1000,
      error=coalesce(error,'abandoned after total runtime deadline') where run_type='direct_nv_ingestion' and status='running'
      and started_at < now()-($1::int * interval '1 millisecond')`,[totalTimeoutMs]));
    const config=await activeConfig(db); const sources=await discoverSources(db,registryFile);
    if (!sources.length) throw new Error('active NV source registry contains zero sources');
    const expectedRaw=process.env.NV_EXPECTED_ACTIVE_COUNT;
    if (expectedRaw !== undefined && (!/^\d+$/.test(expectedRaw) || Number(expectedRaw) !== sources.length)) {
      throw new Error(`active NV source count does not match NV_EXPECTED_ACTIVE_COUNT; expected ${expectedRaw}, got ${sources.length}`);
    }
    runId=(await db.query(`insert into sync_runs(run_type,status,files_total,meta) values('direct_nv_ingestion','running',$1,$2) returning id`,
      [sources.length,json({read_only_google:true,config_version:config.version,source:'employee-sheets',master_as_data:false,timeouts:{page_ms:pageTimeoutMs,source_ms:sourceTimeoutMs,total_ms:totalTimeoutMs}})])).rows[0].id;
    progress({event:'start',status:'running',sources:sources.length});
    heartbeat=setInterval(()=>progress({event:'heartbeat',status:'running'}),heartbeatMs); heartbeat.unref?.();
    api ||= await createReadonlyApi();
    // pg Client permits only one query at a time. Serialize checkpoint writes while sheet reads remain concurrent.
    let checkpointQueue = Promise.resolve();
    const safeCheckpoint = event => {
      const next = checkpointQueue.then(() => queued(()=>checkpoint(db,runId,event)));
      checkpointQueue = next.catch(() => {});
      return next;
    };
    const cached=await queued(()=>resumablePages(db,config.version));
    const rows=await collectNvRows({api,sources,configVersion:config.version,concurrency,pageRows,pageTimeoutMs,sourceTimeoutMs,
      sourceRetries,checkpoint:safeCheckpoint,progress,resumePages:source=>cached.get(`${source.google_file_id}:${source.sheet_name}`)||new Map(),assertActive,deadlineAt});
    await checkpointQueue;
    assertActive();
    const diagnostics = rows.diagnostics || {successful:sources.length,empty:0,failed:0,total:sources.length,errors:[],failed_sources:[],fresh_source_ids:sources.map(x=>x.google_file_id)};
    await db.query(`update sync_runs set meta=meta || $2::jsonb where id=$1`, [runId, json({source_counts:{successful:diagnostics.successful,empty:diagnostics.empty,failed:diagnostics.failed,total:diagnostics.total},errors:diagnostics.errors})]);
    await db.query('begin');
    try {
      await db.query(`select set_config('statement_timeout',$1,true)`,[String(Math.max(1,Math.floor(deadlineAt-Date.now())))]);
      await upsert(db,'nv_posts_staging',rows.map(r=>({...r,run_id:runId,mapped_row:json(r.mapped_row)})),['run_id','row_key'],['source_hash'],{noUpdatedAt:true,maxParams:30000});
      await db.query('commit');
    } catch(error) { await db.query('rollback'); throw error; }
    assertActive();
    const result=await publisher(db,runId,config.version,rows,sources.length,{statementTimeoutMs:Math.max(1,deadlineAt-Date.now()),diagnostics});
    assertActive();
    terminal=true; progress({event:'final',status:diagnostics.failed?'partial':'published',lastKnownGoodPreserved:Boolean(diagnostics.failed),...result});
    return result;
  } catch(error) {
    if(runId) await queued(()=>db.query(`update sync_runs set status='fail',finished_at=now(),duration_ms=extract(epoch from(now()-started_at))*1000,error=$2 where id=$1`,[runId,String(error.message).slice(0,2000)])).catch(()=>{});
    terminal=true; progress({event:'final',status:'blocked',error:String(error.message),lastKnownGoodPreserved:true});
    error.nvFinalLogged=true;
    throw error;
  } finally { clearInterval(heartbeat); await dbQueue; if(!terminal) progress({event:'final',status:'blocked',error:'terminated without final status',lastKnownGoodPreserved:true}); if(locked)await db.query(`select pg_advisory_unlock(hashtext('onicorn:direct-nv-run'))`).catch(()=>{}); if(ownDb) await db.end(); }
}
