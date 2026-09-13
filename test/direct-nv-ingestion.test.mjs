import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoogleApi } from '../src/google/googleApi.mjs';
import { COLUMN_MAPPING, collectNvRows, discoverSources, normalizeNvRow, readSource, resolveHeader } from '../src/ingestion/directNv.mjs';
import { runDirectNvIngestion } from '../src/ingestion/directNvRunner.mjs';

const header=COLUMN_MAPPING.map(x=>x[0]);
const data=i=>['2026-09-01',`Brand ${i}`,`Channel ${i}`,`https://example.com/post/${i}`,`Employee ${i}`,'Không','',100+i,10,2,1,3,90,9,1,1,2,0.17,'Đã đăng',0,'Có','2026-09-02'];
const sources=Array.from({length:24},(_,i)=>({nv_id:`NV${String(i+1).padStart(2,'0')}`,google_file_id:`file-${i+1}`,sheet_name:'BAO CAO HANG NGAY',active:true,expected_columns:22}));

test('fixture registry has 20-30 entries and preserves/skips inactive NV15/NV16',async()=>{
  const fixture=JSON.parse(fs.readFileSync('config/nv-sources.example.json','utf8'));
  assert.equal(fixture.sources.length,24);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nv-registry-')); const file=path.join(dir,'registry.json'); fs.writeFileSync(file,JSON.stringify(fixture));
  const prior=process.env.INACTIVE_STAFF_IDS; process.env.INACTIVE_STAFF_IDS='NV15,NV16';
  try { const active=await discoverSources({},file); assert.equal(active.length,22); assert.ok(active.every(x=>!['NV15','NV16'].includes(x.nv_id))); }
  finally { if(prior===undefined) delete process.env.INACTIVE_STAFF_IDS; else process.env.INACTIVE_STAFF_IDS=prior; }
});

test('finds real employee header at row 5 and preserves data source row numbers',async()=>{
  const source={nv_id:'NV05',google_file_id:'file-5',sheet_name:'BAO CAO HANG NGAY'};
  const title=['BÁO CÁO NHÂN VIÊN'];
  const instruction=['Nhập dữ liệu từ dòng bên dưới'];
  const api={spreadsheetMeta:async()=>({sheets:[{properties:{title:source.sheet_name,gridProperties:{rowCount:6}}}]}),values:async()=>({values:[title,instruction,[],['Tháng 09/2026'],header.map((h,i)=>i===0?' ngày đăng bài ':h),data(5)]})};
  const rows=await readSource(api,source);
  assert.equal(rows.length,1); assert.equal(rows[0].sourceRow,6); assert.deepEqual(rows[0].values,data(5));
});

test('ignores preformatted blank/template rows when calculating malformed ratio',async()=>{
  const source={nv_id:'NV01',google_file_id:'file-1',sheet_name:'BAO CAO HANG NGAY'};
  const blank=Array(22).fill(''); const partial=Array(22).fill(''); partial[2]='TikTok';
  const api={spreadsheetMeta:async()=>({sheets:[{properties:{title:source.sheet_name,gridProperties:{rowCount:8}}}]}),values:async()=>({values:[header,data(1),blank,blank,partial,blank,blank,blank]})};
  const checkpoints=[]; const rows=await collectNvRows({api,sources:[source],configVersion:'master-v1',checkpoint:event=>{checkpoints.push(event)}});
  assert.equal(rows.length,1); assert.equal(rows[0].source_row,2); assert.equal(checkpoints.at(-1).status,'ok');
  assert.match(checkpoints.at(-1).error,/sourceRow/);
});

test('readable valid empty source is skipped with empty diagnostic',async()=>{
  const source={nv_id:'NV13',google_file_id:'empty-13',sheet_name:'BAO CAO HANG NGAY'};
  const api={spreadsheetMeta:async()=>({sheets:[{properties:{title:source.sheet_name,gridProperties:{rowCount:3}}}]}),values:async()=>({values:[['Tiêu đề'],['Hướng dẫn'],header]})};
  const checkpoints=[]; const rows=await collectNvRows({api,sources:[source],configVersion:'master-v1',checkpoint:e=>checkpoints.push(e)});
  assert.equal(rows.length,0); assert.deepEqual(rows.diagnostics,{active:0,empty:1,failed:0,total:1}); assert.equal(checkpoints.at(-1).status,'empty');
});

test('empty sources do not hide zero-total fail-closed guard',async()=>{
  const source={nv_id:'NV19',google_file_id:'empty-19',sheet_name:'BAO CAO HANG NGAY'};
  const api={spreadsheetMeta:async()=>({sheets:[{properties:{title:source.sheet_name,gridProperties:{rowCount:1}}}]}),values:async()=>({values:[header]})};
  const rows=await collectNvRows({api,sources:[source],configVersion:'master-v1'}); assert.equal(rows.length,0);
});

test('exact 22-column mapping and stable idempotency key',()=>{
  assert.equal(COLUMN_MAPPING.length,22); assert.equal(resolveHeader(header),true);
  assert.throws(()=>resolveHeader([...header.slice(0,21),'WRONG']),/mapping mismatch/);
  const a=normalizeNvRow(data(1),sources[0],2,'master-v1'); const b=normalizeNvRow(data(1),sources[0],2,'master-v1');
  assert.equal(a.row_key,b.row_key); assert.equal(a.mapped_row.config_version,'master-v1'); assert.deepEqual(a.mapped_row.raw_values,data(1));
});

test('24 sources use at most three concurrent readers and rerun is idempotent',async()=>{
  let active=0,max=0;
  const api={spreadsheetMeta:async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,2));return {sheets:[{properties:{title:'BAO CAO HANG NGAY',gridProperties:{rowCount:2}}}]}},
    values:async id=>{active--;const i=Number(id.split('-')[1]);return {values:[header,data(i)]}}};
  const first=await collectNvRows({api,sources,configVersion:'master-v1',concurrency:3,pageRows:500});
  const second=await collectNvRows({api,sources,configVersion:'master-v1',concurrency:3,pageRows:500});
  assert.equal(first.length,24); assert.ok(max<=3); assert.deepEqual(first.map(x=>x.row_key),second.map(x=>x.row_key));
});

test('Google reader honors Retry-After on HTTP 429 and stays GET-only',async()=>{
  const original=global.fetch; let calls=0;
  global.fetch=async(_url,opts)=>{calls++;assert.equal(opts.method,undefined);return calls===1
    ? new Response('{"error":"quota"}',{status:429,headers:{'retry-after':'0.001'}})
    : new Response('{"values":[["ok"]]}',{status:200});};
  try {const api=new GoogleApi({minDelayMs:0,maxRetries:2});api.accessToken='test';const result=await api.values('file','A1:A1');assert.equal(calls,2);assert.equal(result.values[0][0],'ok');}
  finally {global.fetch=original;}
});

test('34 active registry sources are accepted without a hard-coded upper bound',async()=>{
  const activeIds=[...Array.from({length:14},(_,i)=>i+1),...Array.from({length:20},(_,i)=>i+17)];
  const activeSources=activeIds.map((id,i)=>({nv_id:`NV${String(id).padStart(2,'0')}`,google_file_id:`active-file-${i+1}`,sheet_name:'BAO CAO HANG NGAY',active:true,expected_columns:22}));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nv-34-')); const file=path.join(dir,'registry.json'); fs.writeFileSync(file,JSON.stringify({sources:activeSources}));
  const db={end:async()=>{},query:async sql=>{
    if(sql.includes('select c.version'))return {rows:[{version:'master-v1',mapping:COLUMN_MAPPING}]};
    if(sql.includes('insert into sync_runs'))return {rows:[{id:'00000000-0000-0000-0000-000000000034'}]};
    return {rows:[]};
  }};
  const api={spreadsheetMeta:async()=>({sheets:[{properties:{title:'BAO CAO HANG NGAY',gridProperties:{rowCount:2}}}]}),values:async id=>({values:[header,data(Number(id.split('-').pop()))]})};
  const result=await runDirectNvIngestion({db,api,registryFile:file,publisher:async(_db,runId,_version,rows,sourceCount)=>({runId,rows:rows.length,sourceCount})});
  assert.equal(result.sourceCount,34); assert.equal(result.rows,34);
});

test('partial source failure never invokes publisher and preserves prior publication',async()=>{
  let published={run_id:'last-good'}; let publisherCalls=0;
  const registry={sources};const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nv-partial-'));const file=path.join(dir,'registry.json');fs.writeFileSync(file,JSON.stringify(registry));
  const db={end:async()=>{},query:async sql=>{
    if(sql.includes('select c.version'))return {rows:[{version:'master-v1',mapping:COLUMN_MAPPING}]};
    if(sql.includes('insert into sync_runs'))return {rows:[{id:'00000000-0000-0000-0000-000000000001'}]};
    return {rows:[]};}};
  const api={spreadsheetMeta:async id=>{if(id==='file-9')throw new Error('upstream partial failure');return {sheets:[{properties:{title:'BAO CAO HANG NGAY',gridProperties:{rowCount:2}}}]}},values:async id=>({values:[header,data(Number(id.split('-')[1]))]})};
  await assert.rejects(runDirectNvIngestion({db,api,registryFile:file,publisher:async()=>{publisherCalls++;published={run_id:'bad'};}}),/partial failure/);
  assert.equal(publisherCalls,0);assert.deepEqual(published,{run_id:'last-good'});
});
