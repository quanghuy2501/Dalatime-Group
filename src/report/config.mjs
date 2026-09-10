import crypto from 'crypto';
import fs from 'fs';

const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;

export function hashReportToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function parseConfig(raw, source) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`Invalid JSON in ${source}`); }
  const entries = Array.isArray(parsed) ? parsed : parsed.customers;
  if (!Array.isArray(entries)) throw new Error(`${source} must contain a customers array`);
  const seen = new Set();
  return entries.map((entry, index) => {
    const tokenHash = String(entry?.tokenHash || '').toLowerCase();
    const clientCode = String(entry?.clientCode || '').trim();
    if (!/^[a-f0-9]{64}$/.test(tokenHash) || !clientCode) {
      throw new Error(`Invalid report customer entry ${index + 1} in ${source}`);
    }
    if (seen.has(tokenHash)) throw new Error(`Duplicate report token hash in ${source}`);
    seen.add(tokenHash);
    return Object.freeze({ tokenHash, clientCode });
  });
}

export function loadReportCustomers(env = process.env) {
  if (env.REPORT_PORTAL_CONFIG_FILE && env.REPORT_PORTAL_CUSTOMERS_JSON) {
    throw new Error('Set only one of REPORT_PORTAL_CONFIG_FILE or REPORT_PORTAL_CUSTOMERS_JSON');
  }
  if (env.REPORT_PORTAL_CONFIG_FILE) {
    return parseConfig(fs.readFileSync(env.REPORT_PORTAL_CONFIG_FILE, 'utf8'), 'REPORT_PORTAL_CONFIG_FILE');
  }
  if (env.REPORT_PORTAL_CUSTOMERS_JSON) {
    return parseConfig(env.REPORT_PORTAL_CUSTOMERS_JSON, 'REPORT_PORTAL_CUSTOMERS_JSON');
  }
  return [];
}

export function resolveReportCustomer(token, customers) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const candidate = Buffer.from(hashReportToken(token), 'hex');
  let match = null;
  for (const customer of customers) {
    const configured = Buffer.from(customer.tokenHash, 'hex');
    if (configured.length === candidate.length && crypto.timingSafeEqual(configured, candidate)) match = customer;
  }
  return match;
}
