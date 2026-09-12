import crypto from 'crypto';

export function parseNumberVN(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v ?? '').trim();
  if (!s) return 0;
  const normalized = s.replace(/\./g, '').replace(/,/g, '.');
  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : 0;
}

// ER is a decimal ratio in application and database layers. At boundaries,
// tolerate legacy percentage points so 0.0482 and 4.82 both mean 4.82%.
export function normalizeEngagementRate(value) {
  const n = typeof value === 'number' ? value : parseNumberVN(value);
  if (!Number.isFinite(n)) return 0;
  return Math.abs(n) > 1 ? n / 100 : n;
}

export function engagementRateFromMetrics({ view = 0, like = 0, comment = 0, save = 0, share = 0 } = {}) {
  const views = Number(view) || 0;
  if (views <= 0) return 0;
  return [like, comment, save, share].reduce((sum, value) => sum + (Number(value) || 0), 0) / views;
}

export function formatEngagementPercent(value, digits = 2) {
  return `${(normalizeEngagementRate(value) * 100).toFixed(digits)}%`;
}

export function parseBoolVN(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return ['có','co','true','1','x','yes','y'].includes(s);
}

function validYmd(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

export function googleSerialToDate(serial) {
  const n = typeof serial === 'number' ? serial : Number.parseFloat(String(serial ?? ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + Math.floor(n) * 86400000).toISOString().slice(0, 10);
}

export function parseDateAny(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return googleSerialToDate(Number(s));
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return validYmd(m[3], m[2], m[1]);
  // Common typo from Sheets/manual input: 27/072026 or 6/72026 => dd/mm/yyyy when valid.
  m = s.match(/^(\d{1,2})\/(\d{1,2})(\d{4})$/);
  if (m) return validYmd(m[3], m[2], m[1]);
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return validYmd(m[1], m[2], m[3]);
  return null;
}

export function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

export function normalizeUrl(url) {
  const s = String(url ?? '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return s;
  }
}

export function splitBrands(raw) {
  const parts = String(raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return parts.length ? parts : ['(Chưa tag brand)'];
}
