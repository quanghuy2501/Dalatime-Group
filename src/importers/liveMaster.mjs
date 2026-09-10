import { GoogleApi } from '../google/googleApi.mjs';
import { parseNumberVN, parseBoolVN, parseDateAny, sha256, normalizeUrl, splitBrands } from '../utils/normalize.mjs';

export const MASTER_ID = process.env.MASTER_SPREADSHEET_ID || '1NS7w8J44x09eD1n5WmaCF6UlZDm8sLYThMf_Nhha4p0';
const INACTIVE_STAFF_IDS = new Set(
  String(process.env.INACTIVE_STAFF_IDS || '')
    .split(',')
    .map(id => id.trim().toUpperCase())
    .filter(Boolean)
);

function isInactiveStatus(value) {
  return /inactive|nghỉ|nghi|đã nghỉ|da nghi|ngưng|ngung|off|disabled/i.test(String(value ?? '').trim());
}

function nonempty(rows) { return (rows || []).filter(r => r.some(c => String(c ?? '').trim())); }
function findHeader(rows, expected) {
  let best = { score: -1, index: -1, row: [] };
  rows.slice(0, 20).forEach((r, i) => {
    const joined = r.map(c => String(c ?? '').trim()).join(' ').toLowerCase();
    const score = expected.reduce((n, k) => n + (joined.includes(k.toLowerCase()) ? 1 : 0), 0) + r.filter(c => String(c ?? '').trim()).length / 20;
    if (score > best.score) best = { score, index: i, row: r };
  });
  return best;
}
function rowsAsObjects(rows, expected) {
  const h = findHeader(rows, expected);
  const headers = h.row.map(x => String(x ?? '').trim());
  return nonempty(rows.slice(h.index + 1)).map((r, idx) => {
    const obj = { __row: h.index + 2 + idx, __values: r };
    headers.forEach((k, i) => { if (k) obj[k] = r[i] ?? ''; });
    return obj;
  });
}
async function readSheetObjects(api, title, rangeRows = 6000) {
  const safe = title.replaceAll("'", "''");
  const res = await api.values(MASTER_ID, `'${safe}'!A1:AZ${rangeRows}`);
  const rows = res.values || [];
  return rowsAsObjects(rows, ['NGÀY ĐĂNG BÀI','TÊN THƯƠNG HIỆU','VIEW','ID','MÃ KH','TIMESTAMP','Tên cấu hình']);
}
export async function loadLiveMasterSnapshot() {
  const api = await new GoogleApi({ minDelayMs: 1300, maxRetries: 6 }).init();
  // Read sequentially. Google Sheets API has a low per-user read/minute quota for service accounts.
  const clients = await readSheetObjects(api, '1. KHACH HANG', 1200);
  const staff = await readSheetObjects(api, '2. NHAN SU', 1200);
  const channels = await readSheetObjects(api, '3. CHANNEL', 1200);
  const brands = await readSheetObjects(api, '4. LIST BRAND', 1200);
  const rawRows = await readSheetObjects(api, 'RAW_DATA', 6000);
  const normalizedRows = await readSheetObjects(api, 'NORMALIZED', 6000);
  const configRows = await readSheetObjects(api, 'CONFIG', 200);
  return { api, serviceAccountEmail: api.serviceAccountEmail, clients, staff, channels, brands, rawRows, normalizedRows, configRows };
}
export function mapClient(o) {
  return { client_code: String(o['MÃ KH'] ?? '').trim() || null, name: String(o['TÊN THƯƠNG HIỆU/ CÔNG TY'] ?? '').trim(), status: String(o['TRẠNG THÁI'] ?? '').trim(), contact_name: String(o['NGƯỜI ĐẠI DIỆN LIÊN HỆ'] ?? '').trim(), report_file_id: String(o['LINK REPORT'] ?? '').trim() || null, raw_row: o.__values, active: true };
}
export function mapStaff(o) {
  const nvId = String(o['ID NHÂN VIÊN'] ?? '').trim() || null;
  const status = o['TRẠNG THÁI'] ?? o['STATUS'] ?? '';
  return { nv_id: nvId, name: String(o['TÊN NHÂN VIÊN'] ?? '').trim(), role: String(o['VỊ TRÍ'] ?? '').trim(), channels_count: Math.round(parseNumberVN(o['SỐ LƯỢNG KÊNH'])), report_file_id: String(o['LINK REPORT'] ?? '').trim() || null, raw_row: o.__values, active: !isInactiveStatus(status) && !INACTIVE_STAFF_IDS.has(String(nvId || '').toUpperCase()) };
}
export function mapBrand(o) {
  return { brand_code: String(o['ID BRAND'] ?? '').trim() || null, name: String(o['TÊN THƯƠNG HIỆU'] ?? '').trim(), client_code: String(o['MÃ KH'] ?? '').trim() || null, client_name: String(o['KHÁCH HÀNG'] ?? '').trim(), group_name: String(o['NHÓM KHÁCH HÀNG'] ?? '').trim(), status: String(o['TRẠNG THÁI'] ?? '').trim(), raw_row: o.__values, active: true };
}
export function mapChannel(o) {
  return { channel_code: String(o['ID CHANNEL'] ?? '').trim() || null, name: String(o['TÊN KÊNH'] ?? '').trim(), username: String(o['USERNAME'] ?? '').trim(), url: String(o['LINK KÊNH'] ?? '').trim(), owner_name: String(o['NGƯỜI PHỤ TRÁCH'] ?? '').trim(), follower: Math.round(parseNumberVN(o['FOLLOWER'])), raw_row: o.__values, active: true };
}
export function mapPostRaw(o) {
  const postUrl = String(o['LINK BÀI ĐĂNG'] ?? '').trim();
  const rawPostedDate = o['NGÀY ĐĂNG BÀI'];
  const postedDate = parseDateAny(rawPostedDate);
  const channel = String(o['TÊN KÊNH'] ?? '').trim();
  const sourceFile = String(o['LINK FILE'] ?? '').trim();
  const urlKey = normalizeUrl(postUrl) || `${sourceFile}:${o.__row}`;
  return {
    dedupe_key: sha256(`${urlKey}|${postedDate ?? ''}|${channel}`),
    source_file_id: sourceFile || null,
    source_row: o.__row,
    posted_date: postedDate,
    raw_posted_date: String(rawPostedDate ?? '').trim(),
    posted_date_parse_ok: !!postedDate,
    brand_text_raw: String(o['TÊN THƯƠNG HIỆU'] ?? '').trim(),
    channel_name: channel,
    post_url: postUrl,
    owner_name: String(o['NGƯỜI PHỤ TRÁCH'] ?? '').trim(),
    is_exclusive: parseBoolVN(o['ĐỘC QUYỀN']),
    viral_label: String(o['VIRAL'] ?? '').trim(),
    realtime_view: Math.round(parseNumberVN(o['VIEW'])),
    realtime_like: Math.round(parseNumberVN(o['LIKE'])),
    realtime_comment: Math.round(parseNumberVN(o['COMMENT'])),
    realtime_save: Math.round(parseNumberVN(o['SAVE'])),
    realtime_share: Math.round(parseNumberVN(o['SHARE'])),
    snapshot_view: Math.round(parseNumberVN(o['VIEW_SNAPSHOOT'])),
    snapshot_like: Math.round(parseNumberVN(o['LIKE_SNAPSHOOT'])),
    snapshot_comment: Math.round(parseNumberVN(o['COMMENT_SNAPSHOOT'])),
    snapshot_save: Math.round(parseNumberVN(o['SAVE_SNAPSHOOT'])),
    snapshot_share: Math.round(parseNumberVN(o['SHARE_SNAPSHOOT'])),
    engagement_rate: parseNumberVN(o['% TƯƠNG TÁC']),
    status: String(o['TRẠNG THÁI'] ?? '').trim(),
    bonus_amount: parseNumberVN(o['THƯỞNG VIRAL']),
    show_channel: String(o['SHOW TÊN KÊNH'] ?? '').trim(),
    viral_confirm_date: parseDateAny(o['NGÀY XÁC NHẬN VIRAL'] ?? ''),
    source_hash: sha256(JSON.stringify(o.__values)),
    raw_values: o.__values
  };
}
export function mapPostBrandsFromRaw(post) {
  return splitBrands(post.brand_text_raw).map(brand => ({ post_dedupe_key: post.dedupe_key, brand_name: brand, source_brand_text: post.brand_text_raw }));
}


export function mapBonusRules(configRows) {
  return configRows.map(o => {
    const fulltime = parseNumberVN(o['SỐ TIỀN THƯỞNG FULLTIME']);
    const parttime = parseNumberVN(o['SỐ TIỀN THƯỞNG PARTIME'] || o['SỐ TIỀN THƯỞNG PARTTIME']);
    return {
      min_snapshot_view: Math.round(parseNumberVN(o['VIEW (mốc)'])),
      max_snapshot_view: null,
      // Keep legacy amount as fulltime for backward-compatible code paths.
      amount: fulltime,
      amount_fulltime: fulltime,
      amount_parttime: parttime,
      raw_source: JSON.stringify(o.__values)
    };
  }).filter(r => r.min_snapshot_view > 0 || r.amount_fulltime > 0 || r.amount_parttime > 0).sort((a, b) => a.min_snapshot_view - b.min_snapshot_view);
}
