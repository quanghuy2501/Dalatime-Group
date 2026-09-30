import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const brandCode = String(process.argv[2] || '').trim();
const output = process.argv[3] || 'config/report-customers.local.json';
const linksPath = process.env.REPORT_PORTAL_LINKS_FILE || 'config/report-links.local.json';
if (!brandCode) throw new Error('Usage: node scripts/generate-brand-report-token.mjs BRAND_CODE [output.json]');

const token = crypto.randomBytes(32).toString('base64url');
const tokenHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
const config = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : { customers: [], brands: [] };
config.customers ||= [];
config.brands = (config.brands || []).filter(item => item.brandCode !== brandCode);
config.brands.push({ brandCode, tokenHash });
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });

const reportPath = `/report/${token}`;
const links = fs.existsSync(linksPath) ? JSON.parse(fs.readFileSync(linksPath, 'utf8')) : { customers: [], brands: [] };
links.customers ||= [];
links.brands = (links.brands || []).filter(item => item.brandCode !== brandCode);
links.brands.push({ brandCode, reportPath });
fs.mkdirSync(path.dirname(linksPath), { recursive: true });
fs.writeFileSync(linksPath, JSON.stringify(links, null, 2) + '\n', { mode: 0o600 });

// This is intentionally one-time secret output. Store it securely and do not commit it.
console.log(JSON.stringify({ brandCode, reportPath, token }, null, 2));
