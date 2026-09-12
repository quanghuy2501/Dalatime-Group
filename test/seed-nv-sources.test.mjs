import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverNvFiles, seedNvSources } from '../scripts/seed-nv-sources.mjs';
const files = Array.from({length:24}, (_,i)=>({id:`id-${i+1}`,name:`NV${String(i+1).padStart(2,'0')}`,mimeType:'application/vnd.google-apps.spreadsheet'}));
test('discovers 24 active sources and skips NV15/NV16',()=>{ const r=discoverNvFiles([...files,{id:'x',name:'NV15',mimeType:'application/vnd.google-apps.spreadsheet'},{id:'y',name:'notes',mimeType:'text/plain'}]); assert.equal(r.sources.length,22); assert.ok(!r.sources.some(x=>x.nv_id==='NV15')); });
test('fails closed on zero discovery',async()=>{ await assert.rejects(()=>seedNvSources({api:{listFolder:async()=>[]},db:{query:async()=>{}},folderId:'folder'}),/expected 20-30; got 0/); });
test('seed is idempotent and transactional',async()=>{let calls=[]; const db={query:async(sql,args)=>{calls.push([sql,args]);}}; const r=await seedNvSources({api:{listFolder:async()=>files},db,folderId:'folder'}); assert.equal(r.sources.length,22); assert.equal(calls[0][0],'begin'); assert.equal(calls.at(-1)[0],'commit'); assert.equal(calls.filter(x=>x[0].startsWith('insert into')).length,22);});
