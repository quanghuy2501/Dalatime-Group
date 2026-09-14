import crypto from 'node:crypto';
import fs from 'node:fs';
import { GoogleApi } from '../google/googleApi.mjs';
import { parseBoolVN, parseDateAny, parseNumberVN, normalizeUrl, splitBrands, engagementRateFromMetrics } from '../utils/normalize.mjs';

export const NV_SHEET = 'BAO CAO HANG NGAY';
export const INACTIVE_NV = new Set(['NV15', 'NV16']);
export const COLUMN_MAPPING = Object.freeze([
  ['NGÀY ĐĂNG BÀI','posted_date'], ['TÊN THƯƠNG HIỆU','brand_text_raw'], ['TÊN KÊNH','channel_name'],
  ['LINK BÀI ĐĂNG','post_url'], ['NGƯỜI PHỤ TRÁCH','owner_name'], ['ĐỘC QUYỀN','is_exclusive'], ['VIRAL','viral_label'],
  ['VIEW','realtime_view'], ['LIKE','realtime_like'], ['COMMENT','realtime_comment'], ['SAVE','realtime_save'], ['SHARE','realtime_share'],
  ['VIEW_SNAPSHOOT','snapshot_view'], ['LIKE_SNAPSHOOT','snapshot_like'], ['COMMENT_SNAPSHOOT','snapshot_comment'],
  ['SAVE_SNAPSHOOT','snapshot_save'], ['SHARE_SNAPSHOOT','snapshot_share'], ['% TƯƠNG TÁC','engagement_rate'],
  ['TRẠNG THÁI','status'], ['THƯỞNG VIRAL','bonus_amount'], ['SHOW TÊN KÊNH','show_channel'], ['NGÀY XÁC NHẬN VIRAL','viral_confirm_date']
]);

const clean = value => String(value ?? '').replace(/^\\uFEFF/, '').trim();
const normalizeHeader = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleUpperCase('und').replace(/[\s_]+/g, ' ').trim();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const positiveNumber = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

export class NvTimeoutError extends Error {
  constructor(scope, timeoutMs) { super(`${scope} timed out after ${timeoutMs}ms`); this.name='NvTimeoutError'; this.code='NV_TIMEOUT'; }
}

export async function withTimeout(operation, timeoutMs, scope) {
  timeoutMs=positiveNumber(timeoutMs,120000);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_,reject)=>{ timer=setTimeout(()=>reject(new NvTimeoutError(scope,timeoutMs)),timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}
const inactiveSet = () => new Set([...INACTIVE_NV, ...clean(process.env.INACTIVE_STAFF_IDS).split(',').map(x => x.trim().toUpperCase()).filter(Boolean)]);

export function validateMapping(mapping = COLUMN_MAPPING) {
  if (!Array.isArray(mapping) || mapping.length !== 22) throw new Error(`mapping mismatch: expected exactly 22 columns, got ${mapping?.length ?? 0}`);
  const headers = mapping.map(x => x[0]);
  const fields = mapping.map(x => x[1]);
  if (new Set(headers).size !== 22 || new Set(fields).size !== 22 || mapping.some(x => !Array.isArray(x) || x.length !== 2)) throw new Error('mapping mismatch: duplicate or malformed mapping');
  return mapping;
}

export function resolveHeader(row, mapping = COLUMN_MAPPING) {
  validateMapping(mapping);
  const actual = (row || []).slice(0, 22).map(normalizeHeader);
  const expected = mapping.map(([name]) => normalizeHeader(name));
  if (actual.length !== 22 || actual.some((value, i) => value !== expected[i])) {
    throw new Error(`mapping mismatch: sheet must contain the ordered 22-column header`);
  }
  return true;
}

export function normalizeNvRow(values, source, sourceRow, configVersion, mapping = COLUMN_MAPPING) {
  if (values.length > 22 && values.slice(22).some(v => clean(v))) throw new Error(`mapping mismatch at ${source.nv_id} row ${sourceRow}: more than 22 populated columns`);
  const raw = Object.fromEntries(mapping.map(([header], i) => [header, values[i] ?? '']));
  const postedDate = parseDateAny(raw['NGÀY ĐĂNG BÀI']);
  const url = normalizeUrl(raw['LINK BÀI ĐĂNG']);
  const channel = clean(raw['TÊN KÊNH']);
  const brand = clean(raw['TÊN THƯƠNG HIỆU']);
  if (!postedDate || !url || !channel || !brand) throw new Error(`invalid required value at ${source.nv_id} row ${sourceRow}`);
  const rowKey = hash(`${url}|${postedDate}|${channel.toLocaleLowerCase('und')}`);
  const number = key => Math.round(parseNumberVN(raw[key]));
  const metrics = { view:number('VIEW'), like:number('LIKE'), comment:number('COMMENT'), save:number('SAVE'), share:number('SHARE') };
  const mapped = { row_key:rowKey, source_file_id:source.google_file_id, source_row:sourceRow, posted_date:postedDate,
    raw_posted_date:clean(raw['NGÀY ĐĂNG BÀI']), posted_date_parse_ok:true, brand_text_raw:brand, channel_name:channel,
    post_url:clean(raw['LINK BÀI ĐĂNG']), owner_name:clean(raw['NGƯỜI PHỤ TRÁCH']), is_exclusive:parseBoolVN(raw['ĐỘC QUYỀN']),
    viral_label:clean(raw.VIRAL), realtime_view:metrics.view, realtime_like:metrics.like, realtime_comment:metrics.comment,
    realtime_save:metrics.save, realtime_share:metrics.share, snapshot_view:number('VIEW_SNAPSHOOT'), snapshot_like:number('LIKE_SNAPSHOOT'),
    snapshot_comment:number('COMMENT_SNAPSHOOT'), snapshot_save:number('SAVE_SNAPSHOOT'), snapshot_share:number('SHARE_SNAPSHOOT'),
    engagement_rate:engagementRateFromMetrics(metrics), status:clean(raw['TRẠNG THÁI']), bonus_amount:parseNumberVN(raw['THƯỞNG VIRAL']),
    show_channel:clean(raw['SHOW TÊN KÊNH']), viral_confirm_date:parseDateAny(raw['NGÀY XÁC NHẬN VIRAL']),
    source_hash:hash(JSON.stringify(values.slice(0,22))), raw_values:values.slice(0,22), config_version:configVersion };
  return { row_key:rowKey, nv_id:source.nv_id, source_file_id:source.google_file_id, source_sheet_name:source.sheet_name,
    source_row:sourceRow, config_version:configVersion, mapped_row:mapped, source_hash:mapped.source_hash };
}

export function loadRegistryFile(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed.sources)) throw new Error('NV registry must contain a sources array');
  return parsed.sources;
}

export async function discoverSources(db, registryFile = process.env.NV_SOURCE_REGISTRY) {
  const sources = registryFile ? loadRegistryFile(registryFile) : (await db.query(`select nv_id,google_file_id,sheet_name,active,expected_columns from nv_ingestion_sources order by nv_id`)).rows;
  const master = clean(process.env.MASTER_SPREADSHEET_ID || '1NS7w8J44x09eD1n5WmaCF6UlZDm8sLYThMf_Nhha4p0');
  const inactive = inactiveSet();
  const seen = new Set();
  return sources.filter(source => {
    source.nv_id = clean(source.nv_id).toUpperCase(); source.google_file_id = clean(source.google_file_id); source.sheet_name = clean(source.sheet_name || NV_SHEET);
    if (!source.nv_id || !source.google_file_id || seen.has(source.google_file_id)) throw new Error('duplicate or incomplete NV source registry');
    seen.add(source.google_file_id);
    if (master && source.google_file_id === master) throw new Error('Master spreadsheet cannot be an NV ingestion source');
    if (source.sheet_name !== NV_SHEET || Number(source.expected_columns ?? 22) !== 22) throw new Error(`invalid source mapping for ${source.nv_id}`);
    return source.active !== false && !inactive.has(source.nv_id);
  });
}

async function mapLimit(items, limit, fn) {
  const result = new Array(items.length); let cursor = 0;
  await Promise.all(Array.from({ length:Math.min(limit, items.length) }, async () => { while (cursor < items.length) { const i = cursor++; result[i] = await fn(items[i]); } }));
  return result;
}

const malformedLimit = () => {
  const value = Number(process.env.NV_MAX_MALFORMED_RATIO ?? 0.5);
  return Number.isFinite(value) && value >= 0 && value < 1 ? value : 0.5;
};

function rowDiagnostic(error, sourceRow, values) {
  const reason = String(error?.message || error).slice(0, 500);
  return { sourceRow, reason, raw: values.slice(0, 22) };
}

export async function readSource(api, source, { pageRows=500, pageTimeoutMs=120000, sourceTimeoutMs=120000,
  checkpoint=async()=>{}, progress=()=>{}, cachedPages=new Map(), assertActive=()=>{}, deadlineAt=Infinity }={}) {
  const remainingTimeout=configured=>Math.max(1,Math.min(configured,deadlineAt-Date.now()));
  return withTimeout(async()=>{
  assertActive();
  const meta = await withTimeout(()=>api.spreadsheetMeta(source.google_file_id),remainingTimeout(pageTimeoutMs),`${source.nv_id} metadata`);
  const sheet = (meta.sheets || []).find(x => x.properties?.title === source.sheet_name);
  if (!sheet) throw new Error(`${source.nv_id}: missing ${source.sheet_name}`);
  const total = Number(sheet.properties.gridProperties?.rowCount || 0); const rows=[]; let headerSeen=false; let headerRow=0;
  for (let start=1; start<=total; start+=pageRows) {
    assertActive();
    const end=Math.min(total,start+pageRows-1); const safe=source.sheet_name.replaceAll("'", "''");
    const cacheKey=`${start}:${end}`; let page=cachedPages.get(cacheKey); let resumed=true;
    if (!page) {
      resumed=false;
      page=(await withTimeout(()=>api.values(source.google_file_id, `'${safe}'!A${start}:V${end}`),remainingTimeout(pageTimeoutMs),`${source.nv_id} page ${start}-${end}`)).values || [];
      cachedPages.set(cacheKey,page);
    }
    for (let i=0; i<page.length; i++) {
      const sheetRow=start+i; const values=page[i] || [];
      if (!headerSeen) {
        // Employee sheets have title/instruction rows before the real header (normally row 5).
        // Search the full ordered A:V signature rather than assuming row 1.
        try { resolveHeader(values); headerSeen=true; headerRow=sheetRow; } catch { /* keep scanning */ }
        continue;
      }
      if (values.some(v => clean(v))) rows.push({ values:values.slice(0, 22), sourceRow:sheetRow });
    }
    await checkpoint({ source, pageStart:start, pageEnd:end, page, nextRow:end+1, rowsRead:rows.length, status:'running' });
    progress({event:'page',nvId:source.nv_id,pageStart:start,pageEnd:end,rowsRead:rows.length,resumed});
  }
  if (!headerSeen) throw new Error(`${source.nv_id}: exact 22-column header not found`);
  await checkpoint({ source, nextRow:total+1, rowsRead:rows.length, status:'ok' });
  return rows;
  },remainingTimeout(sourceTimeoutMs),`${source.nv_id} source`);
}

export async function collectNvRows({ api, sources, configVersion, concurrency=2, pageRows=500, pageTimeoutMs=120000,
  sourceTimeoutMs=120000, sourceRetries=1, checkpoint=async()=>{}, progress=()=>{}, resumePages=()=>new Map(), assertActive=()=>{}, deadlineAt=Infinity }) {
  if (!configVersion) throw new Error('missing Master config_version');
  if (concurrency < 1) throw new Error('NV concurrency must be at least 1');
  concurrency = Math.min(3, concurrency);
  const groups=await mapLimit(sources, concurrency, async source => {
    let lastError;
    for(let attempt=0;attempt<=sourceRetries;attempt++) try {
      progress({event:'source',status:'running',nvId:source.nv_id,attempt:attempt+1});
      const input = await readSource(api,source,{pageRows,pageTimeoutMs,sourceTimeoutMs,checkpoint,progress,cachedPages:await resumePages(source),assertActive,deadlineAt});
      const valid = []; const skipped = [];
      let identityRows = 0;
      for (const row of input) {
        // Real employee sheets contain hundreds of preformatted/template rows after the
        // header. They may have formulas or validation metadata in non-required columns,
        // but no actual post identity. Do not count those intentional blanks as malformed.
        const hasRequiredIdentity = row.values.slice(0, 4).some(value => clean(value));
        if (!hasRequiredIdentity) continue;
        identityRows += 1;
        try { valid.push(normalizeNvRow(row.values,source,row.sourceRow,configVersion)); }
        catch (error) { skipped.push(rowDiagnostic(error,row.sourceRow,row.values)); }
      }
      const ratio = input.length ? skipped.length / input.length : 0;
      // A readable sheet with the exact header and no employee rows is an intentional
      // empty source (common for staff who have not reported yet), not a failure.
      if (!valid.length && identityRows === 0) {
        await checkpoint({source,nextRow:1,rowsRead:0,status:'empty',error:JSON.stringify({message:'empty valid NV source; no employee rows'}).slice(0,2000)});
        progress({event:'source',status:'empty',nvId:source.nv_id,rows:0,attempt:attempt+1});
        return {empty:true, source};
      }
      if (!valid.length || ratio > malformedLimit()) {
        const detail = { message: !valid.length ? 'no valid employee rows' : `malformed row ratio ${ratio.toFixed(3)} exceeds ${malformedLimit()}`, skipped };
        await checkpoint({source,nextRow:1,rowsRead:input.length,status:'fail',error:JSON.stringify(detail).slice(0,2000)});
        throw new Error(`${source.nv_id}: ${detail.message}`);
      }
      if (skipped.length) await checkpoint({source,nextRow:1,rowsRead:input.length,status:'ok',error:JSON.stringify({skipped}).slice(0,2000)});
      progress({event:'source',status:'ok',nvId:source.nv_id,rows:valid.length,attempt:attempt+1});
      return valid;
    } catch(error) {
      lastError=error;
      progress({event:'source',status:attempt<sourceRetries?'retrying':'fail',nvId:source.nv_id,attempt:attempt+1,error:String(error.message)});
      if(attempt<sourceRetries) continue;
    }
    await checkpoint({source,nextRow:1,rowsRead:0,status:'fail',error:String(lastError.message).slice(0,2000)});
    return {error:lastError};
  });
  const failures=groups.filter(group=>group?.error);
  if(failures.length) throw new Error(`${failures.length} NV source(s) failed: ${failures.map(x=>x.error.message).join('; ')}`);
  const empty=groups.filter(group=>group?.empty).length;
  const rows=groups.filter(Array.isArray).flat(); const keys=new Set();
  for (const row of rows) { if (keys.has(row.row_key)) throw new Error(`duplicate idempotency key: ${row.row_key}`); keys.add(row.row_key); }
  Object.defineProperty(rows,'diagnostics',{value:{active:sources.length-empty,empty,failed:0,total:sources.length},enumerable:false});
  return rows;
}

export async function createReadonlyApi() {
  const quotaPerMinute=positiveNumber(process.env.GOOGLE_REQUESTS_PER_MINUTE,55);
  const quotaDelayMs=Math.ceil(60000/Math.min(60,quotaPerMinute));
  return new GoogleApi({ minDelayMs:Math.max(quotaDelayMs,Number(process.env.GOOGLE_READ_DELAY_MS || 0)), maxRetries:Number(process.env.GOOGLE_MAX_RETRIES || 6),
    scopes:['https://www.googleapis.com/auth/spreadsheets.readonly','https://www.googleapis.com/auth/drive.metadata.readonly'] }).init();
}

export { mapLimit, sleep, splitBrands };
