import fs from 'fs';
import crypto from 'crypto';
import { GoogleApi } from '../src/google/googleApi.mjs';

const MASTER_ID = process.env.MASTER_SPREADSHEET_ID || '1NS7w8J44x09eD1n5WmaCF6UlZDm8sLYThMf_Nhha4p0';
const PAIRS = [
  ['RAW_DATA', 'RAW_DATA_DB_STAGING'],
  ['NORMALIZED', 'NORMALIZED_DB_STAGING'],
];
function normalizeCell(v) { return String(v ?? '').trim(); }
function normalizeRow(row, width=26) {
  const out = Array.from({ length: width }, (_, i) => normalizeCell(row[i]));
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}
function rowHash(row) {
  return crypto.createHash('sha256').update(JSON.stringify(normalizeRow(row))).digest('hex');
}
function nonEmptyRows(rows) { return rows.filter(r => r.some(v => normalizeCell(v) !== '')); }
function countDiffs(aRows, bRows) {
  const max = Math.max(aRows.length, bRows.length);
  let differentRows = 0, differentCells = 0;
  const samples = [];
  for (let i = 0; i < max; i++) {
    const a = normalizeRow(aRows[i] || []);
    const b = normalizeRow(bRows[i] || []);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      differentRows++;
      const width = Math.max(a.length, b.length, 26);
      const cellSamples = [];
      for (let c = 0; c < width; c++) {
        if (normalizeCell(a[c]) !== normalizeCell(b[c])) {
          differentCells++;
          if (cellSamples.length < 5) cellSamples.push({ col: c + 1, production: normalizeCell(a[c]), staging: normalizeCell(b[c]) });
        }
      }
      if (samples.length < 10) samples.push({ row: i + 1, cells: cellSamples });
    }
  }
  return { differentRows, differentCells, samples };
}
async function values(api, title) {
  return nonEmptyRows((await api.values(MASTER_ID, `'${title}'!A:Z`)).values || []);
}
const api = await new GoogleApi({ minDelayMs: 1300, maxRetries: 6 }).init();
const report = { generatedAt: new Date().toISOString(), spreadsheetId: MASTER_ID, pairs: [] };
for (const [production, staging] of PAIRS) {
  const prod = await values(api, production);
  const stag = await values(api, staging);
  const prodHashes = new Map(), stagHashes = new Map();
  for (const r of prod) prodHashes.set(rowHash(r), (prodHashes.get(rowHash(r)) || 0) + 1);
  for (const r of stag) stagHashes.set(rowHash(r), (stagHashes.get(rowHash(r)) || 0) + 1);
  let missingInStaging = 0, extraInStaging = 0;
  for (const [h, n] of prodHashes) missingInStaging += Math.max(0, n - (stagHashes.get(h) || 0));
  for (const [h, n] of stagHashes) extraInStaging += Math.max(0, n - (prodHashes.get(h) || 0));
  const positional = countDiffs(prod, stag);
  report.pairs.push({
    production, staging,
    counts: { productionRows: prod.length, stagingRows: stag.length, productionCols: prod[0]?.length || 0, stagingCols: stag[0]?.length || 0 },
    multisetDiff: { missingInStaging, extraInStaging },
    positionalDiff: positional,
    headers: { production: prod[0] || [], staging: stag[0] || [], match: JSON.stringify(normalizeRow(prod[0]||[])) === JSON.stringify(normalizeRow(stag[0]||[])) }
  });
}
fs.mkdirSync('reports/phase3', { recursive: true });
fs.writeFileSync('reports/phase3/staging-vs-production-diff.json', JSON.stringify(report, null, 2));
const md = ['# Phase 3 Staging vs Production Diff', '', `Generated: ${report.generatedAt}`, '', 'Scope: read-only comparison. No production writes.'];
for (const p of report.pairs) {
  md.push('', `## ${p.staging} vs ${p.production}`, `- Header match: ${p.headers.match ? 'YES' : 'NO'}`, `- Production rows: ${p.counts.productionRows}`, `- Staging rows: ${p.counts.stagingRows}`, `- Missing in staging by row hash: ${p.multisetDiff.missingInStaging}`, `- Extra in staging by row hash: ${p.multisetDiff.extraInStaging}`, `- Positional different rows: ${p.positionalDiff.differentRows}`, `- Positional different cells: ${p.positionalDiff.differentCells}`);
  if (p.positionalDiff.samples.length) md.push('', 'Sample positional diffs:', '```json', JSON.stringify(p.positionalDiff.samples.slice(0, 3), null, 2), '```');
}
fs.writeFileSync('reports/phase3/staging-vs-production-diff.md', md.join('\n'));
console.log(JSON.stringify(report.pairs.map(p => ({ pair: `${p.staging} vs ${p.production}`, counts: p.counts, multisetDiff: p.multisetDiff, headerMatch: p.headers.match })), null, 2));
