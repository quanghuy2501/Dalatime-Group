#!/usr/bin/env node
import { createReadonlyApi, NV_SHEET, INACTIVE_NV } from '../src/ingestion/directNv.mjs';
import { connectDb } from '../src/db/postgres.mjs';

const MIN = 20, MAX = 30;
const clean = v => String(v ?? '').trim();
const idFromName = name => { const m = clean(name).match(/\bNV\s*[-_ ]?(\d{1,2})\b/i); return m ? `NV${String(Number(m[1])).padStart(2, '0')}` : null; };
export function discoverNvFiles(files, { inactive = INACTIVE_NV } = {}) {
  const found = [], skipped = [];
  for (const file of files || []) {
    const nvId = idFromName(file.name);
    if (!nvId || file.mimeType !== 'application/vnd.google-apps.spreadsheet') { skipped.push({ name:file.name, reason:'not-an-active-nv-sheet' }); continue; }
    if (inactive.has(nvId)) { skipped.push({ name:file.name, nvId, reason:'inactive' }); continue; }
    found.push({ nv_id:nvId, google_file_id:clean(file.id), sheet_name:NV_SHEET, active:true, expected_columns:22 });
  }
  const unique = new Map();
  for (const source of found) { if (!source.google_file_id || unique.has(source.nv_id) || [...unique.values()].some(x => x.google_file_id === source.google_file_id)) throw new Error(`duplicate or incomplete discovered NV source: ${source.nv_id}`); unique.set(source.nv_id, source); }
  return { sources:[...unique.values()].sort((a,b)=>a.nv_id.localeCompare(b.nv_id, undefined, {numeric:true})), skipped };
}
export async function seedNvSources({ api, db, folderId=process.env.EMPLOYEE_FOLDER_ID, dryRun=false } = {}) {
  if (!folderId) throw new Error('EMPLOYEE_FOLDER_ID is required for NV source discovery');
  const result = discoverNvFiles(await api.listFolder(folderId));
  if (result.sources.length < MIN || result.sources.length > MAX) throw new Error(`active NV source discovery expected ${MIN}-${MAX}; got ${result.sources.length}`);
  if (!dryRun) {
    await db.query('begin');
    try {
      for (const source of result.sources) await db.query(`insert into nv_ingestion_sources (nv_id,google_file_id,sheet_name,active,expected_columns) values ($1,$2,$3,true,22) on conflict (nv_id) do update set google_file_id=excluded.google_file_id,sheet_name=excluded.sheet_name,active=true,expected_columns=22,updated_at=now()`, [source.nv_id,source.google_file_id,source.sheet_name]);
      await db.query('commit');
    } catch (e) { await db.query('rollback'); throw e; }
  }
  return result;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const api = await createReadonlyApi(); const db = await connectDb();
  try { const result = await seedNvSources({api, db}); console.log(JSON.stringify({status:'ok', discovered:result.sources.length, seeded:result.sources.map(x=>x.nv_id), skipped:result.skipped}, null, 2)); }
  catch (error) { console.error(JSON.stringify({status:'blocked', error:error.message, dbWrites:'source-registry-only'}, null, 2)); process.exitCode=1; }
  finally { await db.end(); }
}
