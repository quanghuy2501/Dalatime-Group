import { hashReportToken } from './config.mjs';
import { encryptReportToken } from './registry.mjs';

const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;
const SPECIAL_DUPLICATE_CODE = 'KH00083';

function canonicalName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('vi');
}

function validatedEntry(raw, index) {
  const clientCode = String(raw?.clientCode || '').trim();
  const name = String(raw?.name || '').trim();
  const reportPath = String(raw?.reportPath || '');
  const pathToken = reportPath.startsWith('/report/') ? reportPath.slice('/report/'.length) : '';
  const token = String(raw?.token || pathToken);
  if (!clientCode) throw new Error(`Legacy entry ${index + 1} has no client code`);
  if (!TOKEN_RE.test(token) || reportPath !== `/report/${token}`) {
    throw new Error(`Legacy entry for ${clientCode} has an invalid or inconsistent token path`);
  }
  return { clientCode, name, token, tokenHash: hashReportToken(token) };
}

export function parseLegacyLinks(value) {
  if (!value || !Array.isArray(value.customers)) throw new Error('Legacy export must contain a customers array');
  return value.customers.map(validatedEntry);
}

export function selectLegacyLinks(entries, customersByCode) {
  const groups = new Map();
  for (const entry of entries) {
    const group = groups.get(entry.clientCode) || [];
    group.push(entry);
    groups.set(entry.clientCode, group);
  }
  const selected = [];
  const skipped = [];
  for (const [clientCode, group] of groups) {
    const hashes = new Set(group.map(item => item.tokenHash));
    let entry = group[0];
    if (hashes.size > 1) {
      if (clientCode !== SPECIAL_DUPLICATE_CODE) throw new Error(`Conflicting legacy tokens for ${clientCode}`);
      const customer = customersByCode.get(clientCode);
      const matches = customer ? group.filter(item => canonicalName(item.name) === canonicalName(customer.name)) : [];
      if (matches.length !== 1) {
        skipped.push({ code: clientCode, reason: 'ambiguous-duplicate' });
        continue;
      }
      entry = matches[0];
    }
    const customer = customersByCode.get(clientCode);
    if (!customer) skipped.push({ code: clientCode, reason: 'missing' });
    else if (!customer.active) skipped.push({ code: clientCode, reason: 'inactive' });
    else selected.push(entry);
  }
  return { selected, skipped };
}

export function legacyRegistryValues(entry, key) {
  return { scope: 'customer', code: entry.clientCode, tokenHash: entry.tokenHash, encrypted: encryptReportToken(entry.token, key) };
}
