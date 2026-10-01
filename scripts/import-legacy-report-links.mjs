import fs from 'node:fs';
import { connectDb } from '../src/db/postgres.mjs';
import { parseLegacyLinks, selectLegacyLinks, legacyRegistryValues } from '../src/report/legacy-links.mjs';
import { encryptExistingRegistryToken, importLegacyRegistryToken, registryKey } from '../src/report/registry.mjs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const positional = args.filter(value => value !== '--apply');
if (positional.length > 1) throw new Error('Usage: npm run portal:import-legacy-links -- [--apply] [export.json]');
const inputPath = positional[0] || process.env.REPORT_LEGACY_LINKS_FILE;
if (!inputPath) throw new Error('Legacy export path is required via CLI or REPORT_LEGACY_LINKS_FILE');
if (!fs.existsSync(inputPath)) throw new Error('Legacy export file was not found');
if (process.env.NODE_ENV === 'production' && apply && process.env.REPORT_REGISTRY_PRODUCTION !== '1') {
  throw new Error('Production legacy import blocked; requires --apply and REPORT_REGISTRY_PRODUCTION=1');
}
const key = registryKey();
if (apply && !key) throw new Error('REPORT_REGISTRY_ENCRYPTION_KEY is required for legacy import');
let parsed;
try { parsed = parseLegacyLinks(JSON.parse(fs.readFileSync(inputPath, 'utf8'))); }
catch (error) { throw new Error(`Legacy export validation failed: ${error.message}`); }

const db = await connectDb();
try {
  if (apply) await db.query('begin');
  const codes = [...new Set(parsed.map(item => item.clientCode))];
  const customers = codes.length ? (await db.query(`select client_code,name,active from clients where client_code=any($1::text[])${apply ? ' for share' : ''}`, [codes])).rows : [];
  const { selected, skipped } = selectLegacyLinks(parsed, new Map(customers.map(row => [row.client_code, row])));
  const existing = selected.length ? (await db.query(`select object_code,token_hash,status from report_link_registry where scope='customer' and object_code=any($1::text[])`, [selected.map(item => item.clientCode)])).rows : [];
  const existingByCode = new Map(existing.map(row => [row.object_code, row]));
  const importable = [];
  const enrichable = [];
  for (const entry of selected) {
    const row = existingByCode.get(entry.clientCode);
    if (row?.status === 'active') {
      if (row.token_hash === entry.tokenHash) enrichable.push(entry);
      else skipped.push({ code: entry.clientCode, reason: 'existing-active' });
      continue;
    }
    importable.push(entry);
  }
  if (!apply) {
    console.log(JSON.stringify({ mode: 'dry-run', candidates: parsed.length, wouldImport: importable.length, wouldEncryptExisting: enrichable.length, skipped }));
    process.exit(0);
  }
  for (const entry of importable) {
    const inserted = await importLegacyRegistryToken(db, legacyRegistryValues(entry, key));
    if (!inserted) throw new Error(`Registry row changed during import for ${entry.clientCode}`);
  }
  for (const entry of enrichable) {
    const values = legacyRegistryValues(entry, key);
    const updated = await encryptExistingRegistryToken(db, values);
    if (!updated) throw new Error(`Existing registry row changed during import for ${entry.clientCode}`);
  }
  await db.query('commit');
  console.log(JSON.stringify({ mode: 'applied', imported: importable.length, encryptedExisting: enrichable.length, skipped }));
} catch (error) {
  try { await db.query('rollback'); } catch {}
  throw error;
} finally { await db.end(); }
