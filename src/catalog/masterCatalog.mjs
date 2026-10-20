import crypto from 'node:crypto';
import { GoogleApi } from '../google/googleApi.mjs';
import { mapBrand, mapClient } from '../importers/liveMaster.mjs';

export const MASTER_CATALOG_RUN_TYPE = 'master_catalog_sync';
export const DEFAULT_MASTER_SPREADSHEET_ID = '1NS7w8J44x09eD1n5WmaCF6UlZDm8sLYThMf_Nhha4p0';

const clean = value => String(value ?? '').trim();
const fold = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/\s+/g, ' ').toLocaleLowerCase('und');

function findHeader(rows, expected) {
  let best = { score: -1, index: -1, row: [] };
  rows.slice(0, 20).forEach((row, index) => {
    const joined = (row || []).map(clean).join(' ').toLocaleLowerCase('und');
    const score = expected.reduce((total, key) => total + (joined.includes(key.toLocaleLowerCase('und')) ? 1 : 0), 0)
      + (row || []).filter(value => clean(value)).length / 20;
    if (score > best.score) best = { score, index, row: row || [] };
  });
  if (best.index < 0) throw new Error(`Master catalog header not found: ${expected.join(', ')}`);
  return best;
}

function rowsAsObjects(rows, expected) {
  const header = findHeader(rows || [], expected);
  const headers = header.row.map(clean);
  return (rows || []).slice(header.index + 1).map((row, offset) => {
    const object = { __row: header.index + 2 + offset, __values: row || [] };
    headers.forEach((key, index) => { if (key) object[key] = row?.[index] ?? ''; });
    return object;
  }).filter(object => object.__values.some(value => clean(value)));
}

async function readSheet(api, spreadsheetId, title, expected, maxRows = 2000) {
  const safe = title.replaceAll("'", "''");
  const response = await api.values(spreadsheetId, `'${safe}'!A1:AZ${maxRows}`);
  return rowsAsObjects(response.values || [], expected);
}

export async function loadLiveMasterCatalog({ api, masterSpreadsheetId = process.env.MASTER_SPREADSHEET_ID || DEFAULT_MASTER_SPREADSHEET_ID } = {}) {
  if (!masterSpreadsheetId) throw new Error('MASTER_SPREADSHEET_ID is required');
  const reader = api || await new GoogleApi({ minDelayMs: 1300, maxRetries: 6 }).init();
  const clients = await readSheet(reader, masterSpreadsheetId, '1. KHACH HANG', ['MÃ KH', 'TÊN THƯƠNG HIỆU/ CÔNG TY'], 2000);
  const brands = await readSheet(reader, masterSpreadsheetId, '4. LIST BRAND', ['ID BRAND', 'TÊN THƯƠNG HIỆU', 'MÃ KH'], 2000);
  return { clients, brands, serviceAccountEmail: reader.serviceAccountEmail || null };
}

function assertCode(value, pattern, label, row) {
  if (!pattern.test(clean(value))) throw new Error(`${label} không hợp lệ tại dòng ${row}: ${clean(value) || '(trống)'}`);
}

function duplicateKeys(rows, key) {
  const seen = new Set();
  const duplicates = new Set();
  for (const row of rows) {
    const value = key(row);
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

export function prepareMasterCatalog(snapshot) {
  const clientRows = (snapshot?.clients || []).filter(row => clean(row['MÃ KH']) || clean(row['TÊN THƯƠNG HIỆU/ CÔNG TY']));
  const brandRows = (snapshot?.brands || []).filter(row => clean(row['ID BRAND']) || clean(row['TÊN THƯƠNG HIỆU']));
  const clients = clientRows.map(row => ({ ...mapClient(row), source_row: row.__row }));
  const brands = brandRows.map(row => ({ ...mapBrand(row), source_row: row.__row }));

  for (const client of clients) {
    assertCode(client.client_code, /^KH\d+$/i, 'MÃ KH', client.source_row);
    if (!client.name) throw new Error(`Tên khách hàng bị trống tại dòng ${client.source_row}`);
  }
  for (const brand of brands) {
    assertCode(brand.brand_code, /^CH\d+$/i, 'ID BRAND', brand.source_row);
    assertCode(brand.client_code, /^KH\d+$/i, 'MÃ KH của brand', brand.source_row);
    if (!brand.name) throw new Error(`Tên brand bị trống tại dòng ${brand.source_row}`);
  }

  const duplicateClientIdentities = duplicateKeys(clients, row => `${fold(row.client_code)}|${fold(row.name)}`);
  if (duplicateClientIdentities.length) throw new Error(`Trùng khách hàng trong Master: ${duplicateClientIdentities.join(', ')}`);
  const duplicateBrandCodes = duplicateKeys(brands, row => fold(row.brand_code));
  if (duplicateBrandCodes.length) throw new Error(`Trùng ID BRAND trong Master: ${duplicateBrandCodes.join(', ')}`);

  const clientCodes = new Set(clients.map(row => fold(row.client_code)));
  const orphanBrands = brands.filter(row => !clientCodes.has(fold(row.client_code)));
  if (orphanBrands.length) throw new Error(`Brand không có khách hàng tương ứng: ${orphanBrands.map(row => `${row.brand_code}->${row.client_code}`).join(', ')}`);

  const compactClients = clients.map(({ source_row, ...row }) => row);
  const compactBrands = brands.map(({ source_row, ...row }) => row);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    clients: compactClients.map(row => [row.client_code, row.name, row.status]),
    brands: compactBrands.map(row => [row.brand_code, row.name, row.client_code, row.status])
  })).digest('hex');
  return { clients: compactClients, brands: compactBrands, fingerprint };
}

function byCode(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    const key = clean(row[field]).toUpperCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

export function planClientReconciliation(sourceRows, existingRows) {
  const sourceGroups = byCode(sourceRows, 'client_code');
  const existingGroups = byCode(existingRows, 'client_code');
  const updates = [], inserts = [];
  for (const [code, sources] of sourceGroups) {
    const available = [...(existingGroups.get(code) || [])];
    const unmatched = [];
    for (const source of sources) {
      const matches = available.map((row, index) => ({ row, index })).filter(item => fold(item.row.name) === fold(source.name));
      if (matches.length > 1) throw new Error(`Database có nhiều khách hàng trùng danh tính ${code}/${source.name}`);
      if (matches.length === 1) {
        updates.push({ id: matches[0].row.id, ...source });
        available.splice(matches[0].index, 1);
      } else unmatched.push(source);
    }
    if (unmatched.length === 1 && available.length === 1) updates.push({ id: available[0].id, ...unmatched[0] });
    else if (available.length === 0) inserts.push(...unmatched);
    else if (unmatched.length) throw new Error(`Không thể đối soát an toàn khách hàng có mã trùng ${code}`);
  }
  return { updates, inserts };
}

const clientFields = row => ({
  client_code: row.client_code, name: row.name, status: row.status, contact_name: row.contact_name,
  report_file_id: row.report_file_id, raw_row: row.raw_row, active: row.active
});
const brandFields = row => ({
  brand_code: row.brand_code, name: row.name, client_code: row.client_code, client_name: row.client_name,
  group_name: row.group_name, status: row.status, raw_row: row.raw_row, active: row.active
});

async function updateClients(db, rows) {
  if (!rows.length) return;
  await db.query(`update clients c set client_code=x.client_code,name=x.name,status=x.status,contact_name=x.contact_name,
    report_file_id=x.report_file_id,raw_row=x.raw_row,active=x.active,updated_at=now()
    from jsonb_to_recordset($1::jsonb) as x(id uuid,client_code text,name text,status text,contact_name text,report_file_id text,raw_row jsonb,active boolean)
    where c.id=x.id`, [JSON.stringify(rows.map(row => ({ id: row.id, ...clientFields(row) })))]);
}

async function insertClients(db, rows) {
  if (!rows.length) return;
  await db.query(`insert into clients(client_code,name,status,contact_name,report_file_id,raw_row,active)
    select client_code,name,status,contact_name,report_file_id,raw_row,active
    from jsonb_to_recordset($1::jsonb) as x(client_code text,name text,status text,contact_name text,report_file_id text,raw_row jsonb,active boolean)`,
    [JSON.stringify(rows.map(clientFields))]);
}

async function upsertBrands(db, rows) {
  if (!rows.length) return;
  await db.query(`insert into brands(brand_code,name,client_code,client_name,group_name,status,raw_row,active)
    select brand_code,name,client_code,client_name,group_name,status,raw_row,active
    from jsonb_to_recordset($1::jsonb) as x(brand_code text,name text,client_code text,client_name text,group_name text,status text,raw_row jsonb,active boolean)
    on conflict(brand_code) do update set name=excluded.name,client_code=excluded.client_code,client_name=excluded.client_name,
      group_name=excluded.group_name,status=excluded.status,raw_row=excluded.raw_row,active=excluded.active,updated_at=now()`,
    [JSON.stringify(rows.map(brandFields))]);
}

async function recordFailure(db, error, meta = {}) {
  await db.query(`insert into sync_runs(run_type,status,started_at,finished_at,duration_ms,error,meta)
    values($1,'fail',now(),now(),0,$2,$3)`, [MASTER_CATALOG_RUN_TYPE, clean(error?.message).slice(0, 2000), JSON.stringify(meta)]);
}

export async function publishMasterCatalog(db, catalog, { serviceAccountEmail = null } = {}) {
  const meta = { fingerprint: catalog.fingerprint, counts: { clients: catalog.clients.length, brands: catalog.brands.length }, serviceAccountEmail };
  try {
    await db.query('begin');
    await db.query(`select pg_advisory_xact_lock(hashtext('onicorn:master-catalog-sync'))`);
    const run = (await db.query(`insert into sync_runs(run_type,status,started_at,rows_read,meta)
      values($1,'running',now(),$2,$3) returning id`, [MASTER_CATALOG_RUN_TYPE, catalog.clients.length + catalog.brands.length, JSON.stringify(meta)])).rows[0];
    const codes = [...new Set(catalog.clients.map(row => row.client_code))];
    const existing = codes.length ? (await db.query(`select id,client_code,name from clients where client_code=any($1::text[]) for update`, [codes])).rows : [];
    const plan = planClientReconciliation(catalog.clients, existing);
    await updateClients(db, plan.updates);
    await insertClients(db, plan.inserts);
    await upsertBrands(db, catalog.brands);
    const rowsWritten = plan.updates.length + plan.inserts.length + catalog.brands.length;
    await db.query(`update sync_runs set status='ok',finished_at=now(),duration_ms=extract(epoch from(now()-started_at))*1000,
      rows_written=$2,meta=meta || $3::jsonb where id=$1`, [run.id, rowsWritten, JSON.stringify({ insertedClients: plan.inserts.length, updatedClients: plan.updates.length })]);
    await db.query('commit');
    return { status: 'ok', runId: run.id, counts: meta.counts, insertedClients: plan.inserts.length, updatedClients: plan.updates.length, upsertedBrands: catalog.brands.length, fingerprint: catalog.fingerprint };
  } catch (error) {
    await db.query('rollback').catch(() => {});
    await recordFailure(db, error, meta).catch(() => {});
    throw error;
  }
}

export async function runMasterCatalogSync({ db, api, masterSpreadsheetId } = {}) {
  let snapshot;
  let publishStarted = false;
  try {
    snapshot = await loadLiveMasterCatalog({ api, masterSpreadsheetId });
    const catalog = prepareMasterCatalog(snapshot);
    publishStarted = true;
    return await publishMasterCatalog(db, catalog, { serviceAccountEmail: snapshot.serviceAccountEmail });
  } catch (error) {
    if (db && !publishStarted) await recordFailure(db, error, { stage: snapshot ? 'validate' : 'read' }).catch(() => {});
    throw error;
  }
}
