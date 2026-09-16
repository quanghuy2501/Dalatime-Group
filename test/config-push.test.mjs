import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleApi } from '../src/google/googleApi.mjs';
import { CONFIG_SECTIONS, assertAllowedRange, clearAllowedValues, discoverSection, isPushSourceActive, pushTarget, runConfigPush, writeAllowedValues } from '../src/configPush/configPush.mjs';

const section=(key,rows)=>({...CONFIG_SECTIONS.find(x=>x.key===key),rows,hash:'x'});
const snapshot={sections:[section('brand',[['B1','one','','','','','','active']]),section('channel',[['C1','channel','','','owner']]),section('staff',[['NV01','Name','','','','','']]),section('bonus',[[5000,1,2]])],hash:'a'.repeat(64),version:'sha256:test'};
const source=(id,status='')=>({nv_id:`NV${id}`,google_file_id:`file-${id}`,status,master_registry_present:true});
const rangeFromUrl=url=>decodeURIComponent(url.split('/values/')[1].split(/[?:]/)[0]);
function apiFor(values={}){const calls=[];return {calls,values:async(id,range)=>({values:values[id]?.[range]||[]}),fetchJson:async(url,opts)=>{calls.push({method:opts.method,range:rangeFromUrl(url),body:opts.body});return {};}};}

test('discovers audited header and dynamic last key row while ignoring trailing formulas',()=>{
  const spec=CONFIG_SECTIONS.find(x=>x.key==='staff');
  const values=[['title'],[],[],spec.sourceHeaders,['NV01','A','','','','',0],['','','','','',0],['NV37','B','','','','',0],['','','','','',0]];
  const found=discoverSection(spec,values);
  assert.equal(found.sourceLastRow,7); assert.deepEqual(found.rows.map(x=>x[0]),['NV01','','NV37']); assert.equal(found.rows[0].length,7);
});
test('fails closed if an audited header moves',()=>{const spec=CONFIG_SECTIONS[0];assert.throws(()=>discoverSection(spec,[spec.sourceHeaders]),/data start moved/);});
test('blank is active; inactive and absent-from-Master sources are skipped',()=>{assert.equal(isPushSourceActive(source('01','')),true);assert.equal(isPushSourceActive(source('01','Đã nghỉ')),false);assert.equal(isPushSourceActive({...source('01'),master_registry_present:false}),false);});
test('allowlist permits only dynamic CONFIG data ranges',async()=>{
  for(const range of ["'CONFIG'!A3:H99","'CONFIG'!J3:N3","'CONFIG'!P8:V20","'CONFIG'!X3:Z11"])assert.equal(assertAllowedRange(range),range);
  for(const range of ["'CONFIG'!A2:H3","'CONFIG'!I3:N3","'BAO CAO HANG NGAY'!A3:H9","'NORMALIZED'!A3:H9","'CONFIG'!AA3:AZ9"])assert.throws(()=>assertAllowedRange(range),/outside allowlist/);
  await assert.rejects(writeAllowedValues({},'file',"'OTHER'!A1:H2",[]),/outside allowlist/);
  await assert.rejects(clearAllowedValues({},'file',"'CONFIG'!A1:H2"),/outside allowlist/);
});
test('dry-run reports expand and shrink without writes',async()=>{
  const values={'file-01':{"'CONFIG'!A3:H":[['old'],['stale']],"'CONFIG'!J3:N":[],"'CONFIG'!P3:V":[['NV01','Name','','','','',''],['stale']],"'CONFIG'!X3:Z":[]}};
  const api=apiFor(values);const result=await pushTarget({api,source:source('01'),snapshot});
  assert.equal(result.status,'dry_run');assert.equal(api.calls.length,0);assert.equal(result.diffs.find(x=>x.key==='brand').oldRowCount,2);
});
test('production writes expanded data and clears only stale allowlisted tail',async()=>{
  const values={'file-01':{"'CONFIG'!A3:H":[['old'],['stale']],"'CONFIG'!J3:N":[],"'CONFIG'!P3:V":[],"'CONFIG'!X3:Z":[]}};
  const api=apiFor(values);const checkpoints=[];const result=await pushTarget({api,source:source('01'),snapshot,production:true,saveCheckpoint:x=>checkpoints.push(x)});
  assert.equal(result.status,'updated'); assert.ok(api.calls.some(x=>x.method==='POST'&&x.range==="'CONFIG'!A4:H4"));
  assert.ok(api.calls.every(x=>assertAllowedRange(x.range))); assert.equal(checkpoints.at(-1).stage,'complete');
});
test('matching target sections hash-skip with no writes',async()=>{
  const values={'file-01':Object.fromEntries(snapshot.sections.map(s=>[`'CONFIG'!${s.targetColumns.split(':')[0]}3:${s.targetColumns.split(':')[1]}`,s.rows]))};
  const api=apiFor(values);const result=await pushTarget({api,source:source('01'),snapshot,production:true});assert.equal(result.status,'hash_skip');assert.equal(api.calls.length,0);
});
test('queue caps concurrency at two and isolates a target failure',async()=>{
  let active=0,max=0;const api={values:async(id)=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;if(id==='file-02')throw new Error('isolated');return {values:[]};}};
  const result=await runConfigPush({api,sources:[source('01'),source('02'),source('03')],snapshot,concurrency:9});assert.equal(result.counts.failed,1);assert.equal(max,2);
});
test('Google API honors Retry-After for 429',async()=>{const original=global.fetch;let calls=0;global.fetch=async()=>++calls===1?new Response('{}',{status:429,headers:{'retry-after':'0.001'}}):new Response('{}',{status:200});try{const api=new GoogleApi({minDelayMs:0,maxRetries:1});api.accessToken='x';await api.fetchJson('https://example.test');assert.equal(calls,2);}finally{global.fetch=original;}});
