import fs from 'fs';
import path from 'path';
import { GoogleApi } from '../src/google/googleApi.mjs';

const MASTER_ID = process.env.MASTER_SPREADSHEET_ID || '1NS7w8J44x09eD1n5WmaCF6UlZDm8sLYThMf_Nhha4p0';
const EMP_FOLDER = process.env.EMPLOYEE_FOLDER_ID || '1sIMJ0TTPEC_hu6OBuW8hSHRLbb0Ajcr8';
const KH_FOLDER = process.env.CUSTOMER_REPORT_FOLDER_ID || '1vyhS3oSMzo83G4TkE_k60X0-kRVbkcHV';
const outDir = path.join(process.cwd(), 'reports', 'live-audit');
fs.mkdirSync(outDir, { recursive: true });
function nonempty(rows){return (rows||[]).filter(r=>r.some(c=>String(c??'').trim()))}
function findHeader(rows){const keys=['NGÀY ĐĂNG BÀI','TÊN THƯƠNG HIỆU','TÊN KÊNH','ID NHÂN VIÊN','MÃ KH','TIMESTAMP','Tên cấu hình','VIEW'];let best={score:-1,idx:null,row:[]};(rows||[]).slice(0,15).forEach((r,i)=>{const joined=r.map(c=>String(c??'').trim()).join(' ').toLowerCase();const score=keys.reduce((a,k)=>a+(joined.includes(k.toLowerCase())?1:0),0)+r.filter(c=>String(c??'').trim()).length/20;if(score>best.score)best={score,idx:i,row:r}});return best}
function quick(title, rows){const h=findHeader(rows); return {sheetTitle:title, rowsFetched: rows.length, nonemptyRows: nonempty(rows).length, colsMax: rows.reduce((m,r)=>Math.max(m,r.length),0), headerRow1Based: h.idx==null?null:h.idx+1, header:h.row, dataRowsAfterHeader: h.idx==null?null:nonempty(rows.slice(h.idx+1)).length};}
async function sheetQuick(api, id, title, maxRows=600){const safe=title.replaceAll("'","''"); const j=await api.values(id,`'${safe}'!A1:AZ${maxRows}`); return quick(title, j.values||[]);}

const api = await new GoogleApi({ minDelayMs: 1300, maxRetries: 6 }).init();
const result = { generatedAt:new Date().toISOString(), serviceAccountEmail: api.serviceAccountEmail, mode:'rate-limited-readonly', masterId:MASTER_ID, folders:{employee:EMP_FOLDER,customerReports:KH_FOLDER} };
result.employeeFolderFiles = await api.listFolder(EMP_FOLDER);
result.customerReportFolderFiles = await api.listFolder(KH_FOLDER);
result.masterMeta = await api.spreadsheetMeta(MASTER_ID);
result.masterSheets = [];
for (const title of ['1. KHACH HANG','2. NHAN SU','3. CHANNEL','4. LIST BRAND','RAW_DATA','NORMALIZED','BAO CAO NHAN VIEN','BAO CAO SO LIEU KHACH HANG','CONFIG','SYNC_LOG','SYSTEM_CONFIG','LOCK_FLAG','EMPLOYEE_PATCH_LOG']) {
  try { result.masterSheets.push(await sheetQuick(api, MASTER_ID, title, 1800)); }
  catch(e){ result.masterSheets.push({sheetTitle:title,error:e.message}); }
}
result.employeeSheets = [];
for (const f of result.employeeFolderFiles.filter(f=>f.mimeType==='application/vnd.google-apps.spreadsheet')) {
  try {
    const meta = await api.spreadsheetMeta(f.id);
    const titles = meta.sheets.map(s=>s.properties.title);
    const daily = titles.includes('BAO CAO HANG NGAY') ? await sheetQuick(api, f.id, 'BAO CAO HANG NGAY', 600) : null;
    result.employeeSheets.push({id:f.id,name:f.name,url:f.webViewLink,modifiedTime:f.modifiedTime,sheetTitles:titles,hasDaily:!!daily,hasSummary:titles.includes('BANG TONG HOP'),hasClientReport:titles.includes('BAO CAO SO LIEU KHACH HANG'),hasConfig:titles.includes('CONFIG'),daily});
  } catch(e) { result.employeeSheets.push({id:f.id,name:f.name,error:e.message}); }
}
result.customerReportSheets = [];
for (const f of result.customerReportFolderFiles.filter(f=>f.mimeType==='application/vnd.google-apps.spreadsheet')) {
  try { const meta = await api.spreadsheetMeta(f.id); const titles=meta.sheets.map(s=>s.properties.title); result.customerReportSheets.push({id:f.id,name:f.name,url:f.webViewLink,modifiedTime:f.modifiedTime,sheetTitles:titles,hasNormalized:titles.includes('NORMALIZED')}); }
  catch(e){ result.customerReportSheets.push({id:f.id,name:f.name,error:e.message}); }
}
fs.writeFileSync(path.join(outDir,'live-audit.json'), JSON.stringify(result,null,2));
const md=['# Live Audit Rate Limited','',`Generated: ${result.generatedAt}`,`Service account: ${result.serviceAccountEmail}`,'','## Counts',`- Employee files: ${result.employeeFolderFiles.length}`,`- Employee spreadsheets audited: ${result.employeeSheets.length}`,`- Customer report files: ${result.customerReportFolderFiles.length}`,`- Customer report spreadsheets audited: ${result.customerReportSheets.length}`,'','## Master sheets',...result.masterSheets.map(s=>`- ${s.sheetTitle}: rows=${s.rowsFetched??'ERR'}, nonempty=${s.nonemptyRows??''}, cols=${s.colsMax??''}, dataRows=${s.dataRowsAfterHeader??''}${s.error?' ERROR='+s.error:''}`),'','## Employee errors',...result.employeeSheets.filter(e=>e.error||!e.hasDaily).map(e=>`- ${e.name}: ${e.error||'missing daily'}`),'','## Customer report errors',...result.customerReportSheets.filter(e=>e.error).map(e=>`- ${e.name}: ${e.error}`)];
fs.writeFileSync(path.join(outDir,'live-audit.md'), md.join('\n'));
console.log(path.join(outDir,'live-audit.md'));
