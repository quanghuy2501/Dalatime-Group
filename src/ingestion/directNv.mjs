import crypto from 'node:crypto';
import fs from 'node:fs';
import { GoogleApi } from '../google/googleApi.mjs';
import { parseBoolVN, parseDateAny, parseNumberVN, normalizeUrl, splitBrands } from '../utils/normalize.mjs';

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

const clean = value => String(value ?? '').trim();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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
  const actual = (row || []).map(clean);
  if (actual.length !== 22 || mapping.some(([name], i) => actual[i] !== name)) {
    throw new Error(`mapping mismatch: sheet must contain the exact ordered 22-column header`);
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
  const mapped = { row_key:rowKey, source_file_id:source.google_file_id, source_row:sourceRow, posted_date:postedDate,
    raw_posted_date:clean(raw['NGÀY ĐĂNG BÀI']), posted_date_parse_ok:true, brand_text_raw:brand, channel_name:channel,
    post_url:clean(raw['LINK BÀI ĐĂNG']), owner_name:clean(raw['NGƯỜI PHỤ TRÁCH']), is_exclusive:parseBoolVN(raw['ĐỘC QUYỀN']),
    viral_label:clean(raw.VIRAL), realtime_view:number('VIEW'), realtime_like:number('LIKE'), realtime_comment:number('COMMENT'),
    realtime_save:number('SAVE'), realtime_share:number('SHARE'), snapshot_view:number('VIEW_SNAPSHOOT'), snapshot_like:number('LIKE_SNAPSHOOT'),
    snapshot_comment:number('COMMENT_SNAPSHOOT'), snapshot_save:number('SAVE_SNAPSHOOT'), snapshot_share:number('SHARE_SNAPSHOOT'),
    engagement_rate:parseNumberVN(raw['% TƯƠNG TÁC']), status:clean(raw['TRẠNG THÁI']), bonus_amount:parseNumberVN(raw['THƯỞNG VIRAL']),
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

export async function readSource(api, source, { pageRows=500, checkpoint=async()=>{} }={}) {
  const meta = await api.spreadsheetMeta(source.google_file_id);
  const sheet = (meta.sheets || []).find(x => x.properties?.title === source.sheet_name);
  if (!sheet) throw new Error(`${source.nv_id}: missing ${source.sheet_name}`);
  const total = Number(sheet.properties.gridProperties?.rowCount || 0); const rows=[]; let headerSeen=false;
  for (let start=1; start<=total; start+=pageRows) {
    const end=Math.min(total,start+pageRows-1); const safe=source.sheet_name.replaceAll("'", "''");
    const page=(await api.values(source.google_file_id, `'${safe}'!A${start}:V${end}`)).values || [];
    for (let i=0; i<page.length; i++) {
      const sheetRow=start+i; const values=page[i];
      if (!headerSeen) { if (clean(values[0]) === COLUMN_MAPPING[0][0]) { resolveHeader(values); headerSeen=true; } continue; }
      if (values.some(v => clean(v))) rows.push({ values, sourceRow:sheetRow });
    }
    await checkpoint({ source, nextRow:end+1, rowsRead:rows.length, status:'running' });
  }
  if (!headerSeen) throw new Error(`${source.nv_id}: exact 22-column header not found`);
  await checkpoint({ source, nextRow:total+1, rowsRead:rows.length, status:'ok' });
  return rows;
}

export async function collectNvRows({ api, sources, configVersion, concurrency=3, pageRows=500, checkpoint }) {
  if (!configVersion) throw new Error('missing Master config_version');
  if (concurrency < 1 || concurrency > 3) throw new Error('NV concurrency must be between 1 and 3');
  const groups=await mapLimit(sources, concurrency, async source => {
    try { return (await readSource(api,source,{pageRows,checkpoint})).map(r=>normalizeNvRow(r.values,source,r.sourceRow,configVersion)); }
    catch(error) { await checkpoint({source,nextRow:1,rowsRead:0,status:'fail',error:String(error.message).slice(0,2000)}); return {error}; }
  });
  const failures=groups.filter(group=>!Array.isArray(group));
  if(failures.length) throw new Error(`${failures.length} NV source(s) failed: ${failures.map(x=>x.error.message).join('; ')}`);
  const rows=groups.flat(); const keys=new Set();
  for (const row of rows) { if (keys.has(row.row_key)) throw new Error(`duplicate idempotency key: ${row.row_key}`); keys.add(row.row_key); }
  return rows;
}

export async function createReadonlyApi() {
  return new GoogleApi({ minDelayMs:Number(process.env.GOOGLE_READ_DELAY_MS || 250), maxRetries:Number(process.env.GOOGLE_MAX_RETRIES || 6),
    scopes:['https://www.googleapis.com/auth/spreadsheets.readonly','https://www.googleapis.com/auth/drive.metadata.readonly'] }).init();
}

export { mapLimit, sleep, splitBrands };
