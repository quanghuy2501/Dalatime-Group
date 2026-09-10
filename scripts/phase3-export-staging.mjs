import fs from 'fs';
import { GoogleApi } from '../src/google/googleApi.mjs';
import { connectDb } from '../src/db/postgres.mjs';
import { ensureSheet, resizeSheet, clearSheet, writeValues } from '../src/google/sheetsWriter.mjs';

const MASTER_ID = process.env.MASTER_SPREADSHEET_ID || '1NS7w8J44x09eD1n5WmaCF6UlZDm8sLYThMf_Nhha4p0';
const dryRun = process.argv.includes('--dry-run');
const RAW_STAGING = 'RAW_DATA_DB_STAGING';
const NORM_STAGING = 'NORMALIZED_DB_STAGING';
const TITLE_ROW = ['BÁO CÁO CÔNG VIỆC HÀNG NGÀY'];
const BLANK_ROW = [];
const GROUP_ROW = ['', '', '', '', '', '', '', 'REALTIME', '', '', '', '', 'SNAPSHOOT', '', '', '', '', '', '', '', '', '', '', '', '', 'VIRAL BONUS'];
const RAW_HEADER = ['NGÀY ĐĂNG BÀI','TÊN THƯƠNG HIỆU','TÊN KÊNH','LINK BÀI ĐĂNG','NGƯỜI PHỤ TRÁCH','ĐỘC QUYỀN','VIRAL','VIEW','LIKE','COMMENT','SAVE','SHARE','VIEW_SNAPSHOOT','LIKE_SNAPSHOOT','COMMENT_SNAPSHOOT','SAVE_SNAPSHOOT','SHARE_SNAPSHOOT','% TƯƠNG TÁC','TRẠNG THÁI','THƯỞNG VIRAL','SHOW TÊN KÊNH','SYNC_AT','LINK FILE','LAST_MILESTONE','NOTIFIED_AT','NGÀY XÁC NHẬN VIRAL'];
const NORM_HEADER = ['NGÀY ĐĂNG BÀI','TÊN THƯƠNG HIỆU','TÊN KÊNH','LINK BÀI ĐĂNG','NGƯỜI PHỤ TRÁCH','ĐỘC QUYỀN','VIRAL','VIEW','LIKE','COMMENT','SAVE','SHARE','VIEW_SNAPSHOOT','LIKE_SNAPSHOOT','COMMENT_SNAPSHOOT','SAVE_SNAPSHOOT','SHARE_SNAPSHOOT','% TƯƠNG TÁC','TRẠNG THÁI','THƯỞNG VIRAL','SHOW TÊN KÊNH','SYNC_AT','','','','NGÀY XÁC NHẬN VIRAL'];
function asDate(v){ if(!v) return ''; const d = new Date(v); if(Number.isNaN(d.getTime())) return String(v).slice(0,10); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }
function yesNo(v){ return v ? 'Có' : ''; }
function n(v){ return v == null ? 0 : Number(v); }
function pad26(a){ const out = Array.isArray(a) ? [...a] : []; while(out.length < 26) out.push(''); return out.slice(0,26); }
function rawRow(r){ return pad26(typeof r.raw_values === 'string' ? JSON.parse(r.raw_values) : r.raw_values); }
function normRow(r){ const base = pad26(typeof r.raw_values === 'string' ? JSON.parse(r.raw_values) : r.raw_values); base[1] = r.brand_name || ''; return base; }
const db = await connectDb();
const raw = (await db.query('select * from posts_raw_sheet order by source_file_id nulls last, source_row nulls last, row_key')).rows;
const norm = (await db.query('select pb.*, pr.raw_values from post_brands_sheet pb join posts_raw_sheet pr on pr.row_key=pb.raw_sheet_row_key order by pb.raw_sheet_row_key, pb.brand_name')).rows;
const rawRows = [TITLE_ROW, BLANK_ROW, GROUP_ROW, RAW_HEADER, ...raw.map(rawRow)];
const normRows = [TITLE_ROW, BLANK_ROW, GROUP_ROW, NORM_HEADER, ...norm.map(normRow)];
const summary = { generatedAt:new Date().toISOString(), dryRun, sheets:{ [RAW_STAGING]:{rows:rawRows.length, cols:RAW_HEADER.length}, [NORM_STAGING]:{rows:normRows.length, cols:NORM_HEADER.length} } };
if (!dryRun) {
  const api = await new GoogleApi({minDelayMs:1300,maxRetries:6}).init();
  for (const [title, rows] of [[RAW_STAGING, rawRows], [NORM_STAGING, normRows]]) {
    const sheetId = await ensureSheet(api, MASTER_ID, title);
    await resizeSheet(api, MASTER_ID, sheetId, rows.length + 10, Math.max(26, rows[0]?.length || 26));
    await clearSheet(api, MASTER_ID, title);
    const written = await writeValues(api, MASTER_ID, title, rows, { chunkSize: 1500 });
    summary.sheets[title].written = written;
  }
}
fs.mkdirSync('reports/phase3',{recursive:true});
fs.writeFileSync(`reports/phase3/staging-export-${dryRun?'dry-run':'write'}.json`, JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
await db.end();
