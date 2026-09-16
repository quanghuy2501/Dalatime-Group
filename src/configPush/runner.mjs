import { connectDb } from '../db/postgres.mjs';
import { createConfigPushApi, isPushSourceActive, readMasterConfig, runConfigPush } from './configPush.mjs';

const json = value => JSON.stringify(value);

async function registry(db) {
  return (await db.query(`select nv_id,google_file_id,sheet_name,status,active,master_registry_present from nv_ingestion_sources order by nv_id`)).rows;
}

async function masterSnapshot(api) {
  const id = process.env.MASTER_SPREADSHEET_ID;
  if (!id) throw new Error('MASTER_SPREADSHEET_ID is required');
  const [meta, snapshot] = await Promise.all([
    api.fetchJson(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,modifiedTime&supportsAllDrives=true`),
    readMasterConfig(api, id)
  ]);
  return { ...snapshot, modifiedTime: meta.modifiedTime || null };
}

export async function executeConfigPush({ production = false, db, api, log = console.log } = {}) {
  if (production && !(process.env.CONFIG_PUSH_PRODUCTION === '1' && process.env.NODE_ENV === 'production')) {
    throw new Error('production requires --production, CONFIG_PUSH_PRODUCTION=1, and NODE_ENV=production');
  }
  const ownDb = !db; db ||= await connectDb(); let runId = null;
  try {
    api ||= await createConfigPushApi({ production });
    let [sources, snapshot] = await Promise.all([registry(db), masterSnapshot(api)]);
    if (!sources.length) throw new Error('source registry is empty');
    if (production && process.env.CONFIG_PUSH_FULL_ROLLOUT !== '1') {
      const pilotIds = [...new Set(String(process.env.CONFIG_PUSH_PILOT_NV_IDS || '').split(',').map(value => value.trim().toUpperCase()).filter(Boolean))];
      if (pilotIds.length < 2 || pilotIds.length > 3) throw new Error('production pilot requires CONFIG_PUSH_PILOT_NV_IDS containing exactly 2 or 3 registry IDs; full rollout additionally requires CONFIG_PUSH_FULL_ROLLOUT=1');
      const selected = sources.filter(source => pilotIds.includes(String(source.nv_id).toUpperCase()) && isPushSourceActive(source));
      if (selected.length !== pilotIds.length) throw new Error('one or more production pilot IDs are missing or inactive in the registry');
      sources = selected;
    }
    if (production) {
      runId = (await db.query(`insert into config_push_runs(mode,status,snapshot_version,snapshot_hash,files_total) values('production','running',$1,$2,$3) returning id`, [snapshot.version,snapshot.hash,sources.length])).rows[0].id;
    }
    const loadCheckpoint = production ? async source => (await db.query(`select snapshot_hash,stage,completed_sections from config_push_file_audit where run_id=(select id from config_push_runs where mode='production' and snapshot_hash=$1 and status in ('partial','failed') order by started_at desc limit 1) and google_file_id=$2`, [snapshot.hash,source.google_file_id])).rows[0] || null : async () => null;
    const saveCheckpoint = production ? async ({ source, snapshot: snap, stage, completedSections=[] }) => db.query(`insert into config_push_file_audit(run_id,nv_id,google_file_id,snapshot_hash,stage,status,completed_sections) values($1,$2,$3,$4,$5,'running',$6) on conflict(run_id,google_file_id) do update set stage=excluded.stage,snapshot_hash=excluded.snapshot_hash,completed_sections=excluded.completed_sections,updated_at=now()`, [runId,source.nv_id,source.google_file_id,snap.hash,stage,json(completedSections)]) : async () => {};
    const result = await runConfigPush({ api, sources, snapshot, production, concurrency: Number(process.env.CONFIG_PUSH_CONCURRENCY || 2), timeoutMs: Number(process.env.CONFIG_PUSH_FILE_TIMEOUT_MS || 120000), loadCheckpoint, saveCheckpoint,
      onResult: ({ fileId: _fileId, ...item }) => log(json({ job:'config_push', mode:production?'production':'dry-run', ...item })) });
    if (production) {
      for (const item of result.results) await db.query(`insert into config_push_file_audit(run_id,nv_id,google_file_id,snapshot_hash,stage,status,writes,error,duration_ms,section_diff) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(run_id,google_file_id) do update set stage=excluded.stage,status=excluded.status,writes=excluded.writes,error=excluded.error,duration_ms=excluded.duration_ms,section_diff=excluded.section_diff,updated_at=now()`, [runId,item.nvId,item.fileId,snapshot.hash,item.status==='failed'?'failed':'complete',item.status,item.writes,item.error||null,item.durationMs||null,json(item.diffs||[])]);
      const status=result.counts.failed ? 'partial' : 'ok';
      await db.query(`update config_push_runs set status=$2,files_ok=$3,files_fail=$4,writes=$5,finished_at=now(),summary=$6 where id=$1`, [runId,status,result.active-result.counts.failed,result.counts.failed,result.results.reduce((sum,x)=>sum+x.writes,0),json(result.counts)]);
      result.runId=runId; result.status=status;
    } else result.status=result.counts.failed?'partial':'dry_run';
    return result;
  } catch (error) {
    if (runId) await db.query(`update config_push_runs set status='failed',files_fail=files_total,finished_at=now(),summary=$2 where id=$1`, [runId,json({error:String(error.message||error).slice(0,2000)})]).catch(()=>{});
    throw error;
  } finally { if (ownDb) await db.end(); }
}
