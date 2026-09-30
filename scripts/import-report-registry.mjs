import fs from 'fs';
import { connectDb } from '../src/db/postgres.mjs';
import { loadReportCustomers } from '../src/report/config.mjs';
import { upsertRegistryToken } from '../src/report/registry.mjs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const configPath = args.find(value => value !== '--apply');
if (!configPath) throw new Error('Usage: npm run portal:import-config -- [--apply] <config.json>');
if (!fs.existsSync(configPath)) throw new Error(`Config not found: ${configPath}`);
const entries = loadReportCustomers({ REPORT_PORTAL_CONFIG_FILE: configPath });
if (!apply) {
  console.log(JSON.stringify({ mode: 'dry-run', entries: entries.length, customers: entries.filter(x => x.scope === 'customer').length, brands: entries.filter(x => x.scope === 'brand').length }, null, 2));
  process.exit(0);
}
if (process.env.NODE_ENV === 'production' && process.env.REPORT_REGISTRY_PRODUCTION !== '1') throw new Error('Production import blocked; set REPORT_REGISTRY_PRODUCTION=1 only after approval');
const db = await connectDb();
try {
  await db.query('begin');
  for (const entry of entries) await upsertRegistryToken(db, { scope: entry.scope, code: entry.scope === 'brand' ? entry.brandCode : entry.clientCode, tokenHash: entry.tokenHash });
  await db.query('commit');
  console.log(JSON.stringify({ mode: 'applied', entries: entries.length, plaintextImported: false }));
} catch (error) { await db.query('rollback'); throw error; }
finally { await db.end(); }
