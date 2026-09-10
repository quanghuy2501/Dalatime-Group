import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { connectDb } from '../src/db/postgres.mjs';

const configPath = process.argv[2] || 'config/report-customers.local.json';
const exportPath = process.argv[3] || `reports/report-token-export-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
const linksPath = process.env.REPORT_PORTAL_LINKS_FILE || 'config/report-links.local.json';
const db = await connectDb();
try {
  const { rows } = await db.query('select client_code,name from clients where active=true and client_code is not null order by client_code');
  const existing = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : { customers: [] };
  const byCode = new Map((existing.customers || []).map(x => [x.clientCode, x]));
  const oneTime = [];
  for (const row of rows) {
    const token = crypto.randomBytes(32).toString('base64url');
    byCode.set(row.client_code, { clientCode: row.client_code, tokenHash: crypto.createHash('sha256').update(token).digest('hex') });
    oneTime.push({ clientCode: row.client_code, name: row.name, reportPath: `/report/${token}` });
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ customers: [...byCode.values()] }, null, 2) + '\n', { mode: 0o600 });
  fs.mkdirSync(path.dirname(exportPath), { recursive: true });
  fs.writeFileSync(exportPath, JSON.stringify({ generatedAt: new Date().toISOString(), oneTime: true, customers: oneTime }, null, 2) + '\n', { mode: 0o600 });
  fs.mkdirSync(path.dirname(linksPath), { recursive: true });
  fs.writeFileSync(linksPath, JSON.stringify({ generatedAt: new Date().toISOString(), customers: oneTime.map(({ clientCode, reportPath }) => ({ clientCode, reportPath })) }, null, 2) + '\n', { mode: 0o600 });
  console.log(`Activated ${oneTime.length} active customers. Secure config: ${configPath}. One-time export: ${exportPath}. Admin links: ${linksPath}`);
} finally { await db.end(); }
