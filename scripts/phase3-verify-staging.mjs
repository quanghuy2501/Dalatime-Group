import fs from 'fs';
import { GoogleApi } from '../src/google/googleApi.mjs';
import { connectDb } from '../src/db/postgres.mjs';
const MASTER_ID = process.env.MASTER_SPREADSHEET_ID || '1NS7w8J44x09eD1n5WmaCF6UlZDm8sLYThMf_Nhha4p0';
const api = await new GoogleApi({minDelayMs:1300,maxRetries:6}).init();
const db = await connectDb();
async function get(title, range){ return (await api.values(MASTER_ID, `'${title}'!${range}`)).values || []; }
// Production-compatible layout: title row, blank row, group row, then 26-column header row.
const rawHeader = await get('RAW_DATA_DB_STAGING','A4:Z4');
const normHeader = await get('NORMALIZED_DB_STAGING','A4:Z4');
const rawAll = await get('RAW_DATA_DB_STAGING','A:Z');
const normAll = await get('NORMALIZED_DB_STAGING','A:Z');
const nonEmptyRows = rows => rows.filter(r => r.some(v => String(v||'').trim() !== '')).length;
const counts = {
  dbRaw: Number((await db.query('select count(*) from posts_raw_sheet')).rows[0].count),
  dbNorm: Number((await db.query('select count(*) from post_brands_sheet')).rows[0].count),
  sheetRawRows: nonEmptyRows(rawAll),
  sheetNormRows: nonEmptyRows(normAll),
  rawHeaderCols: rawHeader[0]?.length || 0,
  normHeaderCols: normHeader[0]?.length || 0,
};
// The blank row is intentionally omitted by nonEmptyRows, so 3 non-empty layout rows precede DB data.
const result={generatedAt:new Date().toISOString(), counts, pass: counts.sheetRawRows===counts.dbRaw+3 && counts.sheetNormRows===counts.dbNorm+3 && counts.rawHeaderCols===26 && counts.normHeaderCols===26};
fs.writeFileSync('reports/phase3/staging-verify.json', JSON.stringify(result,null,2));
fs.writeFileSync('reports/phase3/staging-verify.md', ['# Phase 3 Staging Verify', '', `Generated: ${result.generatedAt}`, '', `Status: ${result.pass?'PASS':'FAIL'}`, '', `- DB raw rows: ${counts.dbRaw}`, `- Sheet RAW staging rows incl header: ${counts.sheetRawRows}`, `- DB normalized rows: ${counts.dbNorm}`, `- Sheet NORMALIZED staging rows incl header: ${counts.sheetNormRows}`, `- RAW header cols: ${counts.rawHeaderCols}`, `- NORMALIZED header cols: ${counts.normHeaderCols}`].join('\n'));
console.log(JSON.stringify(result,null,2));
await db.end();
