import { normalizeUrl } from '../utils/normalize.mjs';

const text = value => String(value ?? '').trim();
const folded = value => text(value).toLocaleLowerCase('und');

export function canonicalPostUrl(value) {
  return folded(normalizeUrl(value)).replace(/[?#].*$/, '').replace(/\/+$/, '');
}

function findHeader(values, required) {
  const wanted = required.map(folded);
  const index = (values || []).findIndex(row => {
    const cells = new Set((row || []).map(folded));
    return wanted.every(name => cells.has(name));
  });
  if (index < 0) throw new Error(`header not found (required: ${required.join(', ')})`);
  return { index, headers: values[index].map(text) };
}

export function sheetRecords(source, required) {
  const values = source?.values || [];
  const { index, headers } = findHeader(values, required);
  const rows = [];
  const dropped = { before_or_header: index + 1, empty: 0, invalid_schema_or_status: 0 };
  for (let offset = index + 1; offset < values.length; offset += 1) {
    const cells = values[offset] || [];
    if (!cells.some(value => text(value))) { dropped.empty += 1; continue; }
    const row = { __sheet_row: offset + 1 };
    headers.forEach((header, column) => { if (header) row[header] = cells[column] ?? ''; });
    rows.push(row);
  }
  return { rows, dropped };
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, 'en'));
}

function activeStatus(value) {
  return !/inactive|nghỉ|nghi|đã nghỉ|da nghi|ngưng|ngung|off|disabled/i.test(text(value));
}

function validId(value, prefix) {
  return new RegExp(`^${prefix}\\d+$`, 'i').test(text(value));
}

function validReferenceRows(snapshot) {
  const result = {};
  const specs = {
    clients: {
      required: ['MÃ KH', 'TÊN THƯƠNG HIỆU/ CÔNG TY', 'TRẠNG THÁI'],
      valid: row => validId(row['MÃ KH'], 'KH') && text(row['TÊN THƯƠNG HIỆU/ CÔNG TY']) && text(row['TRẠNG THÁI']),
      key: row => [folded(row['MÃ KH']), folded(row['TÊN THƯƠNG HIỆU/ CÔNG TY']), folded(row['TRẠNG THÁI']), true]
    },
    staff: {
      required: ['ID NHÂN VIÊN', 'TÊN NHÂN VIÊN', 'TÌNH TRẠNG'],
      valid: row => validId(row['ID NHÂN VIÊN'], 'NV') && text(row['TÊN NHÂN VIÊN']) && text(row['TÌNH TRẠNG']),
      key: row => [folded(row['ID NHÂN VIÊN']), folded(row['TÊN NHÂN VIÊN']), activeStatus(row['TÌNH TRẠNG'])]
    },
    channels: {
      required: ['ID CHANNEL', 'TÊN KÊNH'],
      valid: row => validId(row['ID CHANNEL'], 'CH') && text(row['TÊN KÊNH']),
      key: row => [folded(row['ID CHANNEL']), folded(row['TÊN KÊNH']), true]
    },
    brands: {
      required: ['ID BRAND', 'TÊN THƯƠNG HIỆU', 'MÃ KH', 'TRẠNG THÁI'],
      valid: row => validId(row['ID BRAND'], 'CH') && text(row['TÊN THƯƠNG HIỆU']) && validId(row['MÃ KH'], 'KH') && text(row['TRẠNG THÁI']),
      key: row => [folded(row['ID BRAND']), folded(row['TÊN THƯƠNG HIỆU']), folded(row['MÃ KH']), folded(row['TRẠNG THÁI']), true]
    }
  };
  for (const [name, spec] of Object.entries(specs)) {
    const parsed = sheetRecords(snapshot.sources[name], spec.required);
    const valid = parsed.rows.filter(spec.valid);
    parsed.dropped.invalid_schema_or_status = parsed.rows.length - valid.length;
    result[name] = { keys: uniqueSorted(valid.map(row => JSON.stringify(spec.key(row)))), dropped: parsed.dropped };
  }
  return result;
}

function postKeys(snapshot) {
  const raw = sheetRecords(snapshot.sources.raw_data, ['LINK BÀI ĐĂNG']);
  const normalized = sheetRecords(snapshot.sources.normalized, ['TÊN THƯƠNG HIỆU', 'LINK BÀI ĐĂNG']);
  const rawKeys = uniqueSorted(raw.rows.map(row => canonicalPostUrl(row['LINK BÀI ĐĂNG'])).filter(Boolean));
  const pairKeys = uniqueSorted(normalized.rows.map(row => {
    const url = canonicalPostUrl(row['LINK BÀI ĐĂNG']);
    const brand = folded(row['TÊN THƯƠNG HIỆU']);
    return url && brand ? JSON.stringify([url, brand]) : '';
  }).filter(Boolean));
  raw.dropped.invalid_schema_or_status = raw.rows.length - raw.rows.filter(row => canonicalPostUrl(row['LINK BÀI ĐĂNG'])).length;
  normalized.dropped.invalid_schema_or_status = normalized.rows.length - normalized.rows.filter(row => canonicalPostUrl(row['LINK BÀI ĐĂNG']) && folded(row['TÊN THƯƠNG HIỆU'])).length;
  return { raw_data: { keys: rawKeys, dropped: raw.dropped }, normalized: { keys: pairKeys, dropped: normalized.dropped } };
}

export function canonicalMaster(snapshot) {
  if (snapshot?.status !== 'complete' || snapshot?.locked !== true) throw new Error('snapshot must be complete and locked');
  return { ...validReferenceRows(snapshot), ...postKeys(snapshot) };
}

export function compareKeySets(master, database) {
  const checks = {};
  for (const name of ['clients', 'staff', 'channels', 'brands', 'raw_data', 'normalized']) {
    const expected = new Set(master[name].keys);
    const actual = new Set(database[name] || []);
    const missing = [...expected].filter(key => !actual.has(key)).sort();
    const extra = [...actual].filter(key => !expected.has(key)).sort();
    checks[name] = {
      master_count: expected.size, database_count: actual.size,
      missing_count: missing.length, extra_count: extra.length,
      missing: name === 'raw_data' ? missing : missing.map(JSON.parse), extra: name === 'raw_data' ? extra : extra.map(JSON.parse),
      dropped_sheet_rows: master[name].dropped
    };
  }
  return checks;
}

export async function loadCanonicalDatabase(db) {
  const queries = {
    clients: `select json_build_array(lower(trim(client_code)),lower(trim(name)),lower(trim(status)),active)::text key from clients where client_code ~* '^KH[0-9]+$' and nullif(trim(name),'') is not null and nullif(trim(status),'') is not null`,
    staff: `select json_build_array(lower(trim(nv_id)),lower(trim(name)),active)::text key from staff where nv_id ~* '^NV[0-9]+$' and nullif(trim(name),'') is not null`,
    channels: `select json_build_array(lower(trim(channel_code)),lower(trim(name)),active)::text key from channels where channel_code ~* '^CH[0-9]+$' and nullif(trim(name),'') is not null`,
    brands: `select json_build_array(lower(trim(brand_code)),lower(trim(name)),lower(trim(client_code)),lower(trim(status)),active)::text key from brands where brand_code ~* '^CH[0-9]+$' and nullif(trim(name),'') is not null and client_code ~* '^KH[0-9]+$' and nullif(trim(status),'') is not null`,
    raw_data: `select distinct lower(regexp_replace(regexp_replace(trim(post_url),'[?#].*$',''),'/+$','')) key from posts_raw_sheet where nullif(trim(post_url),'') is not null`,
    normalized: `select distinct json_build_array(lower(regexp_replace(regexp_replace(trim(post_url),'[?#].*$',''),'/+$','')),lower(trim(brand_name)))::text key from post_brands_sheet where nullif(trim(post_url),'') is not null and nullif(trim(brand_name),'') is not null`
  };
  const result = {};
  for (const [name, sql] of Object.entries(queries)) {
    const keys = (await db.query(sql)).rows.map(row => name === 'raw_data' ? row.key : JSON.stringify(JSON.parse(row.key)));
    result[name] = uniqueSorted(keys);
  }
  return result;
}
