import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { connectDb, upsert } from '../src/db/postgres.mjs';
import { mapLockedSnapshot } from '../src/importers/lockedSnapshot.mjs';
import { canonicalMaster, compareKeySets, loadCanonicalDatabase } from '../src/reconciliation/currentWatermarkParity.mjs';
import { getReportOverview } from '../src/report/queries.mjs';

const SOURCE = path.resolve('reports/phase4/master-snapshot-complete-20260911T152206Z.json');
const REPORT_JSON = path.resolve('reports/FINAL-DB-IMPORT-2026-09-12.json');
const REPORT_MD = path.resolve('reports/FINAL-DB-IMPORT-2026-09-12.md');
const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('Z','Z');
const backupPath = path.resolve(`reports/backups/final-db-import-before-${stamp}.sql`);
const started = Date.now();
const snapshot = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
const { validation, tables } = mapLockedSnapshot(snapshot);
const targetNames = Object.keys(tables);
const counts = async db => Object.fromEntries(await Promise.all([...targetNames, 'sync_runs'].map(async name => [name, Number((await db.query(`select count(*)::bigint n from public.${name}`)).rows[0].n)])));
const dollar = json => { let tag='$snapshot$'; while(json.includes(tag)) tag=`$snapshot_${Math.random().toString(36).slice(2)}$`; return `${tag}${json}${tag}`; };
async function writeBackup(db) {
  fs.mkdirSync(path.dirname(backupPath), { recursive:true });
  const schema=`final_import_backup_${stamp.toLowerCase().replace(/[^a-z0-9]/g,'_')}`;
  const lines=['-- Onicorn scoped pre-import SQL snapshot (PostgreSQL 17 compatible)','BEGIN;',`CREATE SCHEMA ${schema};`];
  for (const name of [...targetNames, 'sync_runs']) {
    const rows=(await db.query(`select row_to_json(t) row from public.${name} t`)).rows.map(r=>r.row);
    lines.push(`CREATE TABLE ${schema}.${name} (LIKE public.${name} INCLUDING ALL);`);
    if(rows.length) lines.push(`INSERT INTO ${schema}.${name} SELECT * FROM json_populate_recordset(NULL::public.${name}, ${dollar(JSON.stringify(rows))}::json);`);
  }
  lines.push('COMMIT;',''); fs.writeFileSync(backupPath,lines.join('\n'),{mode:0o600});
}
function assertParity(checks) { const failed=Object.entries(checks).filter(([,c])=>c.missing_count||c.extra_count); if(failed.length) throw new Error(`post-write parity failed: ${failed.map(([n,c])=>`${n}(-${c.missing_count}/+${c.extra_count})`).join(', ')}`); }
async function apiSmoke() {
  const port=4200+Math.floor(Math.random()*500), child=spawn(process.execPath,['src/server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr=''; child.stdout.on('data',d=>stdout+=d); child.stderr.on('data',d=>stderr+=d);
  try {
    for(let i=0;i<100&&!stdout.includes('listening');i++) await new Promise(resolve=>setTimeout(resolve,100));
    if(!stdout.includes('listening')) throw new Error(`API server did not start: ${stderr}`);
    const headers={}; if(process.env.DASHBOARD_BASIC_USER&&process.env.DASHBOARD_BASIC_PASS) headers.authorization=`Basic ${Buffer.from(`${process.env.DASHBOARD_BASIC_USER}:${process.env.DASHBOARD_BASIC_PASS}`).toString('base64')}`;
    const endpoints=['/healthz','/readyz','/api/status','/api/overview','/api/brands?limit=3','/api/staff?limit=3','/api/channels?limit=3','/api/posts?limit=3'], statuses={};
    for(const endpoint of endpoints){const response=await fetch(`http://127.0.0.1:${port}${endpoint}`,{headers});statuses[endpoint]=response.status;if(!response.ok)throw new Error(`${endpoint} returned ${response.status}`);}
    return statuses;
  } finally { child.kill('SIGTERM'); }
}
let db, before=null, after=null, parity=null, metricSmoke=null, httpSmoke=null, syncRunId=null, committed=false, blocker=null;
try {
  db=await connectDb(); await db.query('begin isolation level repeatable read');
  await db.query(`select pg_advisory_xact_lock(hashtext('onicorn:final-locked-snapshot-import'))`);
  before=await counts(db); await writeBackup(db);
  // Exact source parity retains historical duplicate source identifiers/names.
  // Remove only uniqueness rules that contradict the locked mirror rows.
  await db.query(`do $$ declare item record; c text; begin for item in select * from (values ('clients','client_code'),('channels','name'),('brands','name')) v(tbl,col) loop for c in select conname from pg_constraint where conrelid=format('public.%I',item.tbl)::regclass and contype='u' and conkey=array[(select attnum from pg_attribute where attrelid=format('public.%I',item.tbl)::regclass and attname=item.col)] loop execute format('alter table public.%I drop constraint %I',item.tbl,c); end loop; end loop; end $$`);
  await db.query('create index if not exists clients_client_code_idx on public.clients(client_code)');
  await db.query('create index if not exists channels_name_idx on public.channels(name)');
  await db.query('create index if not exists brands_name_idx on public.brands(name)');
  const run=(await db.query(`insert into public.sync_runs(run_type,status,started_at,rows_read,meta) values('final_locked_snapshot_import','running',now(),$1,$2) returning id`,[tables.posts_raw_sheet.length,JSON.stringify({source_run_id:validation.run_id,source_sha256:validation.sha256,backup_path:path.relative(process.cwd(),backupPath)})])).rows[0]; syncRunId=run.id;
  await db.query('delete from public.post_brands_sheet'); await db.query('delete from public.posts_raw_sheet');
  for(const name of ['clients','staff','channels','brands']) await db.query(`delete from public.${name}`);
  const conflicts={clients:[],staff:['nv_id'],channels:['channel_code'],brands:['brand_code'],posts_raw_sheet:['row_key'],post_brands_sheet:['raw_sheet_row_key','brand_name']};
  for(const [name,rows] of Object.entries(tables)) if(rows.length) await upsert(db,`public.${name}`,rows,conflicts[name],Object.keys(rows[0]).filter(k=>!conflicts[name].includes(k)),{maxParams:50000,noUpdatedAt:name==='post_brands_sheet',plainInsert:true});
  parity=compareKeySets(canonicalMaster(snapshot),await loadCanonicalDatabase(db)); assertParity(parity);
  const client=tables.clients.find(r=>r.active && tables.brands.some(b=>b.client_code===r.client_code && b.active));
  if(!client) throw new Error('customer metric smoke has no active customer scope');
  metricSmoke={client_code:client.client_code,overview:await getReportOverview(db,client.client_code)};
  if(!Number.isInteger(metricSmoke.overview.posts)) throw new Error('customer metric smoke returned invalid posts');
  after=await counts(db);
  await db.query(`update public.sync_runs set status='ok',finished_at=now(),duration_ms=$2,rows_written=$3,meta=meta||$4::jsonb where id=$1`,[syncRunId,Date.now()-started,Object.values(tables).reduce((n,r)=>n+r.length,0),JSON.stringify({parity:'pass',counts:after})]);
  await db.query('commit'); committed=true;
} catch(error) { blocker=`${error.code||error.name}: ${error.message}`; if(db) try{await db.query('rollback')}catch{} } finally { if(db) await db.end(); }
if(committed) try{httpSmoke=await apiSmoke();}catch(error){blocker=`post-commit smoke failed: ${error.message}`;}
const publishAllowed=committed&&Boolean(httpSmoke)&&!blocker;
const report={schema_version:1,generated_at:new Date().toISOString(),source:{path:path.relative(process.cwd(),SOURCE),run_id:validation.run_id,sha256:validation.sha256,source_counts:validation.source_counts,canonical_counts:validation.canonical_counts},duration_ms:Date.now()-started,before_counts:before,after_counts:after,backup_path:before?path.relative(process.cwd(),backupPath):null,transaction:{advisory_lock:true,committed,sync_run_id:committed?syncRunId:null},parity,customer_report_metric_smoke:metricSmoke,smoke:{select_parity:committed?'pass':'blocked',customer_report_metric:metricSmoke?'pass':'blocked',health_ready_api:httpSmoke?'pass':'blocked',http_status:httpSmoke},publish_allowed:publishAllowed,status:publishAllowed?'complete':'blocked',blocker};
fs.writeFileSync(REPORT_JSON,JSON.stringify(report,null,2)+'\n');
fs.writeFileSync(REPORT_MD,`# Final DB Import — 2026-09-12\n\n- Status: **${report.status}**\n- Publish allowed: **${publishAllowed}**\n- Source run: \`${validation.run_id}\`\n- Source fingerprint: \`${validation.sha256}\`\n- Transaction committed: **${committed}**\n- Backup: ${report.backup_path?`\`${report.backup_path}\``:'not created'}\n- Duration: ${report.duration_ms} ms\n\n## Before counts\n\n\`${JSON.stringify(before)}\`\n\n## After counts\n\n\`${JSON.stringify(after)}\`\n\n## Verification\n\n- Locked source validation: **pass**\n- In-transaction SELECT parity: **${committed?'pass':'blocked'}**\n- Customer report metric smoke: **${metricSmoke?'pass':'blocked'}**\n- Health, ready, and authenticated API smoke: **${httpSmoke?'pass':'blocked'}**\n\n## Blocker\n\n${blocker||'None.'}\n`);
console.log(JSON.stringify(report,null,2)); if(!publishAllowed) process.exitCode=2;
