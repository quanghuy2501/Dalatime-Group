import crypto from 'crypto';
import { canonicalMaster, canonicalPostUrl, sheetRecords } from '../reconciliation/currentWatermarkParity.mjs';
import { mapBrand, mapChannel, mapClient, mapPostRaw, mapStaff } from './liveMaster.mjs';

export const LOCKED_SNAPSHOT = Object.freeze({
  run_id: 'ee554ffc-519d-4e58-8228-1bcbbaa89d82',
  sha256: 'f293c3e518a27b9e0f22c3656cf606d45402f21a4fef399730d5501821ee0464',
  source_counts: Object.freeze({ clients:149, staff:998, channels:157, brands:174, raw_data:5065, normalized:65296, config:12, sync_log:951 })
});

const text = value => String(value ?? '').trim();
const validId = (value, prefix) => new RegExp(`^${prefix}\\d+$`, 'i').test(text(value));
const activeStatus = value => !/inactive|nghỉ|nghi|đã nghỉ|da nghi|ngưng|ngung|off|disabled/i.test(text(value));

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function sourceFingerprint(sources) {
  const content = Object.fromEntries(Object.entries(sources || {}).map(([key, source]) =>
    [key, Object.fromEntries(Object.entries(source).filter(([field]) => field !== 'origin'))]));
  return crypto.createHash('sha256').update(canonical(content)).digest('hex');
}

export function validateLockedSnapshot(snapshot) {
  const errors = [];
  if (snapshot?.kind !== 'onicorn-master-snapshot' || snapshot?.schema_version !== 1) errors.push('unexpected snapshot kind/schema');
  if (snapshot?.status !== 'complete' || snapshot?.locked !== true || snapshot?.read_only !== true) errors.push('snapshot is not complete, locked, and read-only');
  if (snapshot?.run_id !== LOCKED_SNAPSHOT.run_id || snapshot?.watermark?.run_id !== LOCKED_SNAPSHOT.run_id) errors.push('locked run_id mismatch');
  const fingerprint = sourceFingerprint(snapshot?.sources);
  if (snapshot?.sha256 !== LOCKED_SNAPSHOT.sha256 || fingerprint !== LOCKED_SNAPSHOT.sha256) errors.push('source fingerprint mismatch');
  for (const [name, count] of Object.entries(LOCKED_SNAPSHOT.source_counts)) {
    const source = snapshot?.sources?.[name];
    if (source?.row_count !== count || source?.values?.length !== count) errors.push(`${name} source count mismatch`);
    const dimension = snapshot?.master_dimensions?.[name];
    if (dimension?.rows !== count) errors.push(`${name} dimension count mismatch`);
  }
  if (snapshot?.source_errors?.length) errors.push('snapshot contains source errors');
  if (errors.length) throw new Error(`locked snapshot validation failed: ${errors.join('; ')}`);
  const canonicalCounts = Object.fromEntries(Object.entries(canonicalMaster(snapshot)).map(([name, value]) => [name, value.keys.length]));
  return { run_id: snapshot.run_id, sha256: fingerprint, source_counts: LOCKED_SNAPSHOT.source_counts, canonical_counts: canonicalCounts };
}

function objects(snapshot, name, required) {
  return sheetRecords(snapshot.sources[name], required).rows.map(row => ({ ...row, __row: row.__sheet_row,
    __values: snapshot.sources[name].values[row.__sheet_row - 1] || [] }));
}

function jsonFields(row) {
  for (const key of ['raw_row', 'raw_values']) if (key in row) row[key] = JSON.stringify(row[key]);
  return row;
}

export function mapLockedSnapshot(snapshot) {
  const validation = validateLockedSnapshot(snapshot);
  const clients = objects(snapshot, 'clients', ['MÃ KH','TÊN THƯƠNG HIỆU/ CÔNG TY','TRẠNG THÁI'])
    .filter(r => validId(r['MÃ KH'], 'KH') && text(r['TÊN THƯƠNG HIỆU/ CÔNG TY']) && text(r['TRẠNG THÁI'])).map(r => jsonFields(mapClient(r)));
  const staff = objects(snapshot, 'staff', ['ID NHÂN VIÊN','TÊN NHÂN VIÊN','TÌNH TRẠNG'])
    .filter(r => validId(r['ID NHÂN VIÊN'], 'NV') && text(r['TÊN NHÂN VIÊN']) && text(r['TÌNH TRẠNG'])).map(r => jsonFields({ ...mapStaff(r), active: activeStatus(r['TÌNH TRẠNG']) }));
  const channels = objects(snapshot, 'channels', ['ID CHANNEL','TÊN KÊNH'])
    .filter(r => validId(r['ID CHANNEL'], 'CH') && text(r['TÊN KÊNH'])).map(r => jsonFields(mapChannel(r)));
  const brands = objects(snapshot, 'brands', ['ID BRAND','TÊN THƯƠNG HIỆU','MÃ KH','TRẠNG THÁI'])
    .filter(r => validId(r['ID BRAND'], 'CH') && text(r['TÊN THƯƠNG HIỆU']) && validId(r['MÃ KH'], 'KH') && text(r['TRẠNG THÁI'])).map(r => jsonFields(mapBrand(r)));
  const rawObjects = objects(snapshot, 'raw_data', ['LINK BÀI ĐĂNG']).filter(r => canonicalPostUrl(r['LINK BÀI ĐĂNG']));
  const raw = rawObjects.map(r => {
    const mapped = mapPostRaw(r); delete mapped.dedupe_key;
    return jsonFields({ row_key: crypto.createHash('sha256').update(`${snapshot.run_id}:raw_data:${r.__sheet_row}`).digest('hex'), ...mapped });
  });
  const rawKeyByUrl = new Map();
  raw.forEach(row => { const key = canonicalPostUrl(row.post_url); if (!rawKeyByUrl.has(key)) rawKeyByUrl.set(key, row.row_key); });
  const normalized = objects(snapshot, 'normalized', ['TÊN THƯƠNG HIỆU','LINK BÀI ĐĂNG']).map(r => {
    const url = canonicalPostUrl(r['LINK BÀI ĐĂNG']), brand = text(r['TÊN THƯƠNG HIỆU']);
    if (!url || !brand || !rawKeyByUrl.has(url)) return null;
    const p = mapPostRaw(r);
    return { raw_sheet_row_key: rawKeyByUrl.get(url), brand_name: brand, source_brand_text: brand, posted_date:p.posted_date,
      channel_name:p.channel_name, owner_name:p.owner_name, post_url:p.post_url, realtime_view:p.realtime_view,
      realtime_like:p.realtime_like, realtime_comment:p.realtime_comment, realtime_save:p.realtime_save,
      realtime_share:p.realtime_share, viral_label:p.viral_label, bonus_amount:p.bonus_amount };
  }).filter(Boolean);
  const dedupe = (rows, keys) => [...new Map(rows.map(row => [keys.map(k => String(row[k]).toLocaleLowerCase('und')).join('\0'), row])).values()];
  // The locked sheet intentionally contains two historical customers with the
  // same client code. Preserve both rows; exact parity is row-based, not an
  // invented last-row-wins interpretation.
  const tables = { clients, staff:dedupe(staff,['nv_id']), channels:dedupe(channels,['channel_code']),
    brands:dedupe(brands,['brand_code']), posts_raw_sheet:raw, post_brands_sheet:dedupe(normalized,['raw_sheet_row_key','brand_name']) };
  return { validation, tables };
}
