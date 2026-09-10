import fs from 'fs';
import { GoogleApi } from '../src/google/googleApi.mjs';

const MASTER_ID = process.env.MASTER_SPREADSHEET_ID || '1NS7w8J44x09eD1n5WmaCF6UlZDm8sLYThMf_Nhha4p0';
const approval = process.env.PRODUCTION_SHEET_WRITE_APPROVAL || '';
if (approval !== 'I_APPROVE_OVERWRITE_RAW_DATA_AND_NORMALIZED') {
  throw new Error('Blocked: set PRODUCTION_SHEET_WRITE_APPROVAL exact phrase to proceed.');
}
const api = await new GoogleApi({ minDelayMs: 1300, maxRetries: 6 }).init();
const backupDir = `reports/phase3/backups/${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.mkdirSync(backupDir, { recursive: true });

async function values(title, range) {
  return (await api.values(MASTER_ID, `'${title}'!${range}`)).values || [];
}
async function clear(title, range) {
  return api.fetchJson(`https://sheets.googleapis.com/v4/spreadsheets/${MASTER_ID}/values/${encodeURIComponent(`'${title}'!${range}`)}:clear`, { method: 'POST', body: JSON.stringify({}) });
}
async function write(title, startRow, rows) {
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    const range = `'${title}'!A${startRow + i}`;
    await api.fetchJson(`https://sheets.googleapis.com/v4/spreadsheets/${MASTER_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ range, majorDimension: 'ROWS', values: chunk }) });
  }
}

const targets = [
  ['RAW_DATA', 'RAW_DATA_DB_STAGING'],
  ['NORMALIZED', 'NORMALIZED_DB_STAGING'],
];
const manifest = { generatedAt: new Date().toISOString(), spreadsheetId: MASTER_ID, scope: 'A5:Z only', targets: [] };
for (const [prod, staging] of targets) {
  const prodRows = await values(prod, 'A5:Z');
  const stagingRows = await values(staging, 'A5:Z');
  fs.writeFileSync(`${backupDir}/${prod}-A5-Z.json`, JSON.stringify(prodRows));
  manifest.targets.push({ prod, staging, backupFile: `${prod}-A5-Z.json`, productionRowsBefore: prodRows.length, stagingRows: stagingRows.length });
}
fs.writeFileSync(`${backupDir}/manifest-before.json`, JSON.stringify(manifest, null, 2));

for (const t of manifest.targets) {
  const rows = await values(t.staging, 'A5:Z');
  await clear(t.prod, 'A5:Z');
  await write(t.prod, 5, rows);
  t.productionRowsAfter = rows.length;
}
fs.writeFileSync(`${backupDir}/manifest-after.json`, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ ok: true, backupDir, targets: manifest.targets }, null, 2));
