const clean = value => String(value ?? '').trim();
const fold = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLocaleLowerCase('und');

export const MASTER_STAFF_SHEET = '2. NHAN SU';
export const INACTIVE_STAFF_STATUSES = Object.freeze(['Đã nghỉ', 'inactive', 'disabled', 'retired', 'archived', 'offboarded']);
const inactive = new Set(INACTIVE_STAFF_STATUSES.map(fold));

// Master `TÌNH TRẠNG` is the only lifecycle authority. Blank and every value
// other than the explicitly inactive vocabulary remain active.
export function resolveStaffStatus(status) {
  const value = clean(status);
  return { status: value, active: !inactive.has(fold(value)) };
}

export function isRegisteredSourceActive(source) {
  if (source?.master_registry_present === false) return false;
  return resolveStaffStatus(source?.status).active;
}

const headerKey = value => fold(value).replace(/[\s_]+/g, ' ');
export function parseMasterStaffRegistry(rows = []) {
  const headerIndex = rows.findIndex(row => {
    const keys = (row || []).map(headerKey);
    return keys.includes('id nhan vien') && keys.includes('tinh trang');
  });
  if (headerIndex < 0) throw new Error(`Master ${MASTER_STAFF_SHEET}: required ID NHÂN VIÊN/TÌNH TRẠNG header not found`);
  const headers = rows[headerIndex].map(headerKey);
  const idIndex = headers.indexOf('id nhan vien');
  const statusIndex = headers.indexOf('tinh trang');
  const registry = new Map();
  for (const row of rows.slice(headerIndex + 1)) {
    const nvId = clean(row?.[idIndex]).toUpperCase();
    if (!/^NV\d+$/i.test(nvId)) continue;
    if (registry.has(nvId)) throw new Error(`Master ${MASTER_STAFF_SHEET}: duplicate staff ID ${nvId}`);
    const resolved = resolveStaffStatus(row?.[statusIndex]);
    registry.set(nvId, { nv_id: nvId, ...resolved });
  }
  return registry;
}

export async function readMasterStaffRegistry(api, spreadsheetId, { maxRows = 2000 } = {}) {
  if (!spreadsheetId) throw new Error('MASTER_SPREADSHEET_ID is required');
  const safe = MASTER_STAFF_SHEET.replaceAll("'", "''");
  const response = await api.values(spreadsheetId, `'${safe}'!A1:AZ${maxRows}`);
  return parseMasterStaffRegistry(response.values || []);
}
