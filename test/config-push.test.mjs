import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleApi } from '../src/google/googleApi.mjs';
import { CONFIG_RANGE, MARKER_RANGE, assertAllowedRange, isPushSourceActive, pushTarget, runConfigPush, snapshotConfig, writeAllowedValues } from '../src/configPush/configPush.mjs';

const master=snapshotConfig([['master'],['value']]);
const source=(id,status='')=>({nv_id:`NV${id}`,google_file_id:`file-${id}`,status,active:true});
const rangeFromUrl=url=>decodeURIComponent(url.split('/values/')[1].split('?')[0]);
function apiFor({configs={},markers={},fail=new Set(),hang=new Set()}={}) {
  const writes=[];
  return {writes,values:async(id,range)=>{
    if(hang.has(id))return new Promise(()=>{});
    if(fail.has(id))throw new Error('isolated failure');
    return {values:range===CONFIG_RANGE?(configs[id]||[]):(markers[id]||[])};
  },fetchJson:async(url,opts)=>{const id=decodeURIComponent(url).match(/spreadsheets\/([^/]+)/)[1];const range=rangeFromUrl(url);const values=JSON.parse(opts.body).values;writes.push({id,range,values});if(range===CONFIG_RANGE)configs[id]=values;else markers[id]=values;return {updatedRange:range};}};
}

test('hash marker skips an already applied snapshot',async()=>{
  const api=apiFor({markers:{'file-01':[['CONFIG_PUSH_VERSION',master.version],['CONFIG_PUSH_SHA256',master.hash]]}});
  const result=await pushTarget({api,source:source('01'),snapshot:master,production:true});
  assert.equal(result.status,'hash_skip'); assert.equal(api.writes.length,0);
});
test('blank status is active',()=>assert.equal(isPushSourceActive(source('01','')),true));
test('blank Master status overrides legacy active=false',()=>assert.equal(isPushSourceActive({...source('01',''),active:false}),true));
test('source absent from Master registry is skipped',()=>assert.equal(isPushSourceActive({...source('01','Đang làm'),master_registry_present:false}),false));
test('inactive status is skipped',async()=>{
  const api=apiFor(); const result=await runConfigPush({api,sources:[source('01','inactive')],snapshot:master,production:true});
  assert.equal(result.active,0); assert.equal(api.writes.length,0);
});
test('Google API honors Retry-After for 429',async()=>{
  const original=global.fetch;let calls=0;
  global.fetch=async()=>++calls===1?new Response('{}',{status:429,headers:{'retry-after':'0.001'}}):new Response('{}',{status:200});
  try{const api=new GoogleApi({minDelayMs:0,maxRetries:1});api.accessToken='x';await api.fetchJson('https://example.test');assert.equal(calls,2);}finally{global.fetch=original;}
});
test('per-file timeout is isolated',async()=>{
  const api=apiFor({hang:new Set(['file-01'])}); const result=await runConfigPush({api,sources:[source('01')],snapshot:master,timeoutMs:10});
  assert.equal(result.counts.failed,1);assert.match(result.results[0].error,/timed out/);
});
test('writer enforces exact CONFIG and marker allowlist',async()=>{
  assert.equal(assertAllowedRange(CONFIG_RANGE),CONFIG_RANGE);assert.equal(assertAllowedRange(MARKER_RANGE),MARKER_RANGE);
  assert.throws(()=>assertAllowedRange("'BAO CAO HANG NGAY'!A1"),/outside allowlist/);
  await assert.rejects(writeAllowedValues({},'file',"'OTHER'!A1",[['x']]),/outside allowlist/);
});
test('checkpoint resume writes only marker when CONFIG hash still matches',async()=>{
  const api=apiFor({configs:{'file-01':master.values}});const checkpoints=[];
  const result=await pushTarget({api,source:source('01'),snapshot:master,production:true,checkpoint:{snapshot_hash:master.hash,stage:'config_written'},saveCheckpoint:x=>checkpoints.push(x)});
  assert.equal(result.status,'resumed');assert.deepEqual(api.writes.map(x=>x.range),[MARKER_RANGE]);assert.equal(checkpoints[0].stage,'complete');
});
test('one target failure does not block successful files',async()=>{
  const api=apiFor({fail:new Set(['file-02'])}); const result=await runConfigPush({api,sources:[source('01'),source('02'),source('03')],snapshot:master,production:false,concurrency:9});
  assert.equal(result.counts.failed,1);assert.equal(result.counts.dry_run,2);
});
