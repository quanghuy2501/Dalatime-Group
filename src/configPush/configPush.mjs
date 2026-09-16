import crypto from 'node:crypto';
import { GoogleApi } from '../google/googleApi.mjs';
import { isRegisteredSourceActive } from '../staffStatus.mjs';

const clean = value => String(value ?? '').trim();
const fold = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toUpperCase().replace(/[\s_]+/g, ' ');
const hashJson = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const CONFIG_SECTIONS = Object.freeze([
  Object.freeze({ key:'brand', sourceSheet:'4. LIST BRAND', sourceColumns:'A:I', sourceHeaders:['ID BRAND','TÊN THƯƠNG HIỆU','NHÓM KHÁCH HÀNG','KHÁCH HÀNG','MÃ KH','THỜI GIAN BẮT ĐẦU','THỜI GIAN KẾT THÚC','TRẠNG THÁI','LINK REPORT'], sourceDataRow:5, project:[0,1,2,3,4,5,6,7], targetColumns:'A:H', targetDataRow:3 }),
  Object.freeze({ key:'channel', sourceSheet:'3. CHANNEL', sourceColumns:'A:F', sourceHeaders:['ID CHANNEL','TÊN KÊNH','USERNAME','LINK KÊNH','NGƯỜI PHỤ TRÁCH','FOLLOWER'], sourceDataRow:5, project:[0,1,2,3,4], targetColumns:'J:N', targetDataRow:3 }),
  Object.freeze({ key:'staff', sourceSheet:'2. NHAN SU', sourceColumns:'A:K', sourceHeaders:['ID NHÂN VIÊN','TÊN NHÂN VIÊN','VỊ TRÍ','SỐ ĐIỆN THOẠI','EMAIL','SỐ LƯỢNG KÊNH','MỨC LƯƠNG','LINK REPORT','TICK FULLTIME/PARTIME','TÌNH TRẠNG','SORT TÊN'], sourceDataRow:5, project:[0,1,2,3,4,5,6], targetColumns:'P:V', targetDataRow:3 }),
  Object.freeze({ key:'bonus', sourceSheet:'CONFIG', sourceColumns:'F:H', sourceHeaders:['VIEW (mốc)','SỐ TIỀN THƯỞNG FULLTIME','SỐ TIỀN THƯỞNG PARTIME'], sourceDataRow:4, project:[0,1,2], targetColumns:'X:Z', targetDataRow:3 })
]);

export const isPushSourceActive = isRegisteredSourceActive;
const quoteSheet = name => `'${name.replaceAll("'", "''")}'`;
const sourceRange = section => `${quoteSheet(section.sourceSheet)}!${section.sourceColumns.split(':')[0]}1:${section.sourceColumns.split(':')[1]}`;
export const targetOpenRange = section => `'CONFIG'!${section.targetColumns.split(':')[0]}${section.targetDataRow}:${section.targetColumns.split(':')[1]}`;
const targetRange = (section, start, end = '') => `'CONFIG'!${section.targetColumns.split(':')[0]}${start}:${section.targetColumns.split(':')[1]}${end}`;
const populated = row => (row || []).some(value => clean(value) !== '');

export function discoverSection(section, values = []) {
  const expected = section.sourceHeaders.map(fold);
  const headerIndex = values.findIndex(row => expected.every((header, index) => fold(row?.[index]) === header));
  if (headerIndex < 0) throw new Error(`${section.sourceSheet}: audited header not found in ${section.sourceColumns}`);
  const actualDataRow = headerIndex + 2;
  if (actualDataRow !== section.sourceDataRow) throw new Error(`${section.sourceSheet}: data start moved from audited row ${section.sourceDataRow} to ${actualDataRow}`);
  const candidates = values.slice(headerIndex + 1); let last = -1;
  for (let index=0; index<candidates.length; index++) if (clean(candidates[index]?.[0]) !== '') last=index;
  const rows = last < 0 ? [] : candidates.slice(0,last+1).map(row => section.project.map(index => row?.[index] ?? ''));
  return { ...section, headerRow:headerIndex+1, sourceLastRow:last < 0 ? headerIndex+1 : actualDataRow+last, rows, hash:hashJson(rows) };
}

export async function readMasterConfig(api, spreadsheetId) {
  const response = await api.batchValues(spreadsheetId, CONFIG_SECTIONS.map(sourceRange));
  if ((response.valueRanges || []).length !== CONFIG_SECTIONS.length) throw new Error('Master config batch response is incomplete');
  const sections = CONFIG_SECTIONS.map((section,index) => discoverSection(section,response.valueRanges[index]?.values || []));
  const hash = hashJson(sections.map(({key,rows}) => ({key,rows})));
  return { sections, hash, version:`sha256:${hash.slice(0,16)}` };
}

export function assertAllowedRange(range) {
  const match = /^'CONFIG'!([A-Z]+)(\d+):([A-Z]+)(\d*)$/.exec(range);
  if (!match) throw new Error(`blocked Google write outside allowlist: ${range}`);
  const [,startCol,startRow,endCol,endRow] = match;
  const section=CONFIG_SECTIONS.find(item => item.targetColumns === `${startCol}:${endCol}`);
  if (!section || Number(startRow) < section.targetDataRow || (endRow && Number(endRow) < Number(startRow))) throw new Error(`blocked Google write outside allowlist: ${range}`);
  return range;
}

export async function writeAllowedValues(api, spreadsheetId, range, values, { signal } = {}) {
  assertAllowedRange(range);
  const url=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  return api.fetchJson(url,{method:'PUT',signal,body:JSON.stringify({range,majorDimension:'ROWS',values})});
}

export async function clearAllowedValues(api, spreadsheetId, range, { signal } = {}) {
  assertAllowedRange(range);
  const url=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:clear`;
  return api.fetchJson(url,{method:'POST',signal,body:'{}'});
}

export async function withAbortTimeout(operation, timeoutMs, scope) {
  const controller=new AbortController(); let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{const error=new Error(`${scope} timed out after ${timeoutMs}ms`);controller.abort(error);reject(error);},timeoutMs);});
  try{return await Promise.race([Promise.resolve().then(()=>operation(controller.signal)),timeout]);}finally{clearTimeout(timer);}
}

async function mapLimit(items,limit,fn){const results=new Array(items.length);let cursor=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(cursor<items.length){const index=cursor++;results[index]=await fn(items[index]);}}));return results;}

export function diffTargetSection(section, currentValues = []) {
  let oldLast=-1; for(let index=0;index<currentValues.length;index++)if(populated(currentValues[index]))oldLast=index;
  const oldRows=oldLast < 0 ? [] : currentValues.slice(0,oldLast+1);
  return { matches:hashJson(oldRows)===hashJson(section.rows), oldRowCount:oldRows.length, newRowCount:section.rows.length };
}

export async function pushTarget({api,source,snapshot,production=false,timeoutMs=120000,checkpoint=null,saveCheckpoint=async()=>{}}) {
  const started=Date.now(); const current={};
  for(const section of snapshot.sections) current[section.key]=(await withAbortTimeout(signal=>api.values(source.google_file_id,targetOpenRange(section),{signal}),timeoutMs,`${source.nv_id} ${section.key} read`)).values||[];
  const diffs=snapshot.sections.map(section=>({key:section.key,...diffTargetSection(section,current[section.key])}));
  if(diffs.every(x=>x.matches))return {nvId:source.nv_id,fileId:source.google_file_id,status:'hash_skip',writes:0,diffs,durationMs:Date.now()-started};
  if(!production)return {nvId:source.nv_id,fileId:source.google_file_id,status:'dry_run',writes:0,diffs,durationMs:Date.now()-started};
  let writes=0;
  const completed=new Set(checkpoint?.snapshot_hash===snapshot.hash&&Array.isArray(checkpoint?.completed_sections)?checkpoint.completed_sections:[]);
  for(const section of snapshot.sections){
    const diff=diffs.find(x=>x.key===section.key); if(diff.matches)continue;
    if(section.rows.length){const range=targetRange(section,section.targetDataRow,section.targetDataRow+section.rows.length-1);await withAbortTimeout(signal=>writeAllowedValues(api,source.google_file_id,range,section.rows,{signal}),timeoutMs,`${source.nv_id} ${section.key} write`);writes++;}
    if(diff.oldRowCount>section.rows.length){const start=section.targetDataRow+section.rows.length,end=section.targetDataRow+diff.oldRowCount-1;await withAbortTimeout(signal=>clearAllowedValues(api,source.google_file_id,targetRange(section,start,end),{signal}),timeoutMs,`${source.nv_id} ${section.key} clear`);writes++;}
    completed.add(section.key); await saveCheckpoint({source,snapshot,stage:'sections_writing',completedSections:[...completed]});
  }
  await saveCheckpoint({source,snapshot,stage:'complete',completedSections:[...completed]});
  return {nvId:source.nv_id,fileId:source.google_file_id,status:completed.size?'updated':'hash_skip',writes,diffs,durationMs:Date.now()-started};
}

export async function runConfigPush({api,sources,snapshot,production=false,concurrency=2,timeoutMs=120000,loadCheckpoint=async()=>null,saveCheckpoint=async()=>{},onResult=()=>{}}){
  const active=sources.filter(isPushSourceActive),inactive=sources.filter(source=>!isPushSourceActive(source));
  const results=await mapLimit(active,Math.max(1,Math.min(2,Number(concurrency)||2)),async source=>{try{const result=await pushTarget({api,source,snapshot,production,timeoutMs,checkpoint:await loadCheckpoint(source,snapshot),saveCheckpoint});onResult(result);return result;}catch(error){const result={nvId:source.nv_id,fileId:source.google_file_id,status:'failed',writes:0,error:String(error.message||error)};onResult(result);return result;}});
  return {production,snapshot:{version:snapshot.version,hash:snapshot.hash,modifiedTime:snapshot.modifiedTime,sections:snapshot.sections.map(x=>({key:x.key,sourceLastRow:x.sourceLastRow,rows:x.rows.length,hash:x.hash}))},total:sources.length,active:active.length,inactive:inactive.length,results,counts:Object.fromEntries(['updated','hash_skip','dry_run','failed'].map(status=>[status,results.filter(result=>result.status===status).length]))};
}

export async function createConfigPushApi({production=false}={}){const rpm=Math.min(55,Math.max(1,Number(process.env.CONFIG_PUSH_REQUESTS_PER_MINUTE||55)));return new GoogleApi({minDelayMs:Math.ceil(60000/rpm),maxRetries:Number(process.env.GOOGLE_MAX_RETRIES||6),scopes:[production?'https://www.googleapis.com/auth/spreadsheets':'https://www.googleapis.com/auth/spreadsheets.readonly','https://www.googleapis.com/auth/drive.metadata.readonly']}).init();}
