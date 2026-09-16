#!/usr/bin/env node
import { createReadonlyApi, NV_SHEET } from '../src/ingestion/directNv.mjs';
import { connectDb } from '../src/db/postgres.mjs';
import { readMasterStaffRegistry, resolveStaffStatus } from '../src/staffStatus.mjs';

const clean = v => String(v ?? '').trim();
const idFromName = name => { const m = clean(name).match(/\bNV\s*[-_ ]?(\d{1,3})\b/i); return m ? `NV${String(Number(m[1])).padStart(2, '0')}` : null; };

export function discoverNvFiles(files, { masterStaff } = {}) {
  const found = [], skipped = [], registrySources = [];
  const authoritative = masterStaff instanceof Map ? masterStaff : new Map((masterStaff || []).map(x => [clean(x.nv_id).toUpperCase(), x]));
  const enforceMaster = masterStaff !== undefined;
  for (const file of files || []) {
    const nvId = idFromName(file.name);
    if (!nvId || file.mimeType !== 'application/vnd.google-apps.spreadsheet') { skipped.push({ name:file.name, reason:'not-an-nv-sheet' }); continue; }
    const staff = authoritative.get(nvId);
    if (enforceMaster && !staff) { skipped.push({ name:file.name, nvId, reason:'absent-from-master-registry' }); continue; }
    const resolved = resolveStaffStatus(staff?.status);
    const source = { nv_id:nvId, google_file_id:clean(file.id), sheet_name:NV_SHEET, status:resolved.status, active:resolved.active, master_registry_present:true, expected_columns:22 };
    registrySources.push(source);
    if (!source.active) { skipped.push({ name:file.name, nvId, reason:'inactive-master-status', status:source.status }); continue; }
    found.push(source);
  }
  const unique = new Map();
  for (const source of found) {
    if (!source.google_file_id || unique.has(source.nv_id) || [...unique.values()].some(x => x.google_file_id === source.google_file_id)) throw new Error(`duplicate or incomplete discovered NV source: ${source.nv_id}`);
    unique.set(source.nv_id, source);
  }
  return { sources:[...unique.values()].sort((a,b)=>a.nv_id.localeCompare(b.nv_id, undefined, {numeric:true})), registrySources, skipped };
}

export async function seedNvSources({ api, db, folderId=process.env.EMPLOYEE_FOLDER_ID, masterSpreadsheetId=process.env.MASTER_SPREADSHEET_ID, dryRun=false, masterStaff } = {}) {
  if (!folderId) throw new Error('EMPLOYEE_FOLDER_ID is required for NV source discovery');
  if (masterStaff === undefined) masterStaff = await readMasterStaffRegistry(api, masterSpreadsheetId);
  const result = discoverNvFiles(await api.listFolder(folderId), { masterStaff });
  const expected = process.env.NV_EXPECTED_ACTIVE_COUNT ? Number(process.env.NV_EXPECTED_ACTIVE_COUNT) : null;
  if (!result.sources.length) throw new Error('active NV source discovery expected at least 1; got 0');
  if (expected !== null && (!Number.isInteger(expected) || result.sources.length !== expected)) throw new Error(`active NV source discovery expected ${expected}; got ${result.sources.length}`);
  if (!dryRun) {
    await db.query('begin');
    try {
      await db.query(`update nv_ingestion_sources set master_registry_present=false,updated_at=now()`);
      for (const source of result.registrySources) await db.query(`insert into nv_ingestion_sources (nv_id,google_file_id,sheet_name,status,active,master_registry_present,expected_columns) values ($1,$2,$3,$4,$5,true,22) on conflict (nv_id) do update set google_file_id=excluded.google_file_id,sheet_name=excluded.sheet_name,status=excluded.status,active=excluded.active,master_registry_present=true,expected_columns=22,updated_at=now()`, [source.nv_id,source.google_file_id,source.sheet_name,source.status||null,source.active]);
      await db.query('commit');
    } catch (error) { await db.query('rollback'); throw error; }
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const api = await createReadonlyApi(); const db = await connectDb();
  try { const result = await seedNvSources({api, db}); console.log(JSON.stringify({status:'ok', discovered:result.sources.length, active:result.sources.map(x=>x.nv_id), skipped:result.skipped, googleWrites:0}, null, 2)); }
  catch (error) { console.error(JSON.stringify({status:'blocked', error:error.message, googleWrites:0, dbWrites:'source-registry-only'}, null, 2)); process.exitCode=1; }
  finally { await db.end(); }
}
