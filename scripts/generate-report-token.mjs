import crypto from 'crypto';
import fs from 'fs';

const clientCode = String(process.argv[2] || '').trim();
const output = process.argv[3] || 'config/report-customers.local.json';
if (!clientCode) throw new Error('Usage: node scripts/generate-report-token.mjs CLIENT_CODE [output.json]');
const token = crypto.randomBytes(32).toString('base64url');
const tokenHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
let config = { customers: [] };
if (fs.existsSync(output)) config = JSON.parse(fs.readFileSync(output, 'utf8'));
config.customers = (config.customers || []).filter(x => x.clientCode !== clientCode);
config.customers.push({ clientCode, tokenHash });
fs.mkdirSync(new URL('.', `file://${process.cwd()}/${output}`).pathname, { recursive: true });
fs.writeFileSync(output, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ clientCode, reportPath: `/report/${token}`, token }, null, 2));
