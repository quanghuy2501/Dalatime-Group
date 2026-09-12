import path from 'path';
import { readCsv, nonEmptyRows } from '../utils/csv.mjs';
import { parseNumberVN, parseBoolVN, parseDateAny, sha256, normalizeUrl, splitBrands, engagementRateFromMetrics } from '../utils/normalize.mjs';

export const ROOT = '/Users/quanghuy/Projects/tui-mo-dashboard';

export function loadExtracted(name) {
  return readCsv(path.join(ROOT, `extracted_${name}.csv`));
}

export function findHeader(rows, expected) {
  let best = { score: -1, index: -1, row: [] };
  rows.slice(0, 15).forEach((r, i) => {
    const joined = r.map(c => String(c ?? '').trim()).join(' ').toLowerCase();
    const score = expected.reduce((n, k) => n + (joined.includes(k.toLowerCase()) ? 1 : 0), 0) + r.filter(c => String(c ?? '').trim()).length / 20;
    if (score > best.score) best = { score, index: i, row: r };
  });
  return best;
}

export function rowsAsObjects(rows, expected) {
  const h = findHeader(rows, expected);
  const headers = h.row.map(x => String(x ?? '').trim());
  return nonEmptyRows(rows.slice(h.index + 1)).map((r, idx) => {
    const obj = { __row: h.index + 2 + idx, __values: r };
    headers.forEach((k, i) => { if (k) obj[k] = r[i] ?? ''; });
    return obj;
  });
}

export function parseRawRows() {
  const rows = loadExtracted('RAW_DATA');
  const objs = rowsAsObjects(rows, ['NGÀY ĐĂNG BÀI','TÊN THƯƠNG HIỆU','LINK BÀI ĐĂNG','VIEW']);
  return objs.filter(o => o['NGÀY ĐĂNG BÀI']).map(o => {
    const postUrl = String(o['LINK BÀI ĐĂNG'] ?? '').trim();
    const postedDate = parseDateAny(o['NGÀY ĐĂNG BÀI']);
    const channel = String(o['TÊN KÊNH'] ?? '').trim();
    const sourceFile = String(o['LINK FILE'] ?? '').trim();
    const urlKey = normalizeUrl(postUrl) || `${sourceFile}:${o.__row}`;
    const metrics = {
      view: Math.round(parseNumberVN(o['VIEW'])), like: Math.round(parseNumberVN(o['LIKE'])),
      comment: Math.round(parseNumberVN(o['COMMENT'])), save: Math.round(parseNumberVN(o['SAVE'])), share: Math.round(parseNumberVN(o['SHARE']))
    };
    return {
      dedupe_key: sha256(`${urlKey}|${postedDate ?? ''}|${channel}`),
      source_file_id: sourceFile,
      source_row: o.__row,
      posted_date: postedDate,
      brand_text_raw: String(o['TÊN THƯƠNG HIỆU'] ?? '').trim(),
      channel_name: channel,
      post_url: postUrl,
      owner_name: String(o['NGƯỜI PHỤ TRÁCH'] ?? '').trim(),
      is_exclusive: parseBoolVN(o['ĐỘC QUYỀN']),
      viral_label: String(o['VIRAL'] ?? '').trim(),
      realtime_view: metrics.view,
      realtime_like: metrics.like,
      realtime_comment: metrics.comment,
      realtime_save: metrics.save,
      realtime_share: metrics.share,
      snapshot_view: Math.round(parseNumberVN(o['VIEW_SNAPSHOOT'])),
      snapshot_like: Math.round(parseNumberVN(o['LIKE_SNAPSHOOT'])),
      snapshot_comment: Math.round(parseNumberVN(o['COMMENT_SNAPSHOOT'])),
      snapshot_save: Math.round(parseNumberVN(o['SAVE_SNAPSHOOT'])),
      snapshot_share: Math.round(parseNumberVN(o['SHARE_SNAPSHOOT'])),
      engagement_rate: engagementRateFromMetrics(metrics),
      status: String(o['TRẠNG THÁI'] ?? '').trim(),
      bonus_amount: parseNumberVN(o['THƯỞNG VIRAL']),
      show_channel: String(o['SHOW TÊN KÊNH'] ?? '').trim(),
      viral_confirm_date: parseDateAny(o['NGÀY XÁC NHẬN VIRAL'] ?? ''),
      source_hash: sha256(JSON.stringify(o.__values)),
      raw_values: o.__values
    };
  });
}

export function normalizePostBrands(posts) {
  return posts.flatMap(p => splitBrands(p.brand_text_raw).map(brand => ({
    post_dedupe_key: p.dedupe_key,
    brand_name: brand,
    source_brand_text: p.brand_text_raw,
    posted_date: p.posted_date,
    channel_name: p.channel_name,
    owner_name: p.owner_name,
    post_url: p.post_url,
    realtime_view: p.realtime_view,
    realtime_like: p.realtime_like,
    realtime_comment: p.realtime_comment,
    realtime_save: p.realtime_save,
    realtime_share: p.realtime_share,
    viral_label: p.viral_label,
    bonus_amount: p.bonus_amount
  })));
}

export function parseDimensions() {
  return {
    clients: rowsAsObjects(loadExtracted('1._KHACH_HANG'), ['MÃ KH','TÊN THƯƠNG HIỆU/ CÔNG TY']).filter(r => r['MÃ KH'] || r['TÊN THƯƠNG HIỆU/ CÔNG TY']),
    staff: rowsAsObjects(loadExtracted('2._NHAN_SU'), ['ID NHÂN VIÊN','TÊN NHÂN VIÊN']).filter(r => r['ID NHÂN VIÊN'] || r['TÊN NHÂN VIÊN']),
    channels: rowsAsObjects(loadExtracted('3._CHANNEL'), ['ID CHANNEL','TÊN KÊNH']).filter(r => r['ID CHANNEL'] || r['TÊN KÊNH']),
    brands: rowsAsObjects(loadExtracted('4._LIST_BRAND'), ['ID BRAND','TÊN THƯƠNG HIỆU']).filter(r => r['ID BRAND'] || r['TÊN THƯƠNG HIỆU'])
  };
}
