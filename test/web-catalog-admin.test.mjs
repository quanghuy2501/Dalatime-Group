import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { catalogEntities, createCatalogRow, validateCatalogPayload } from '../src/admin/catalog.mjs';
import { readDatabaseConfig } from '../src/configPush/databaseConfig.mjs';

test('catalog contract exposes the four existing Master registries only', () => {
  assert.deepEqual(catalogEntities,['clients','brands','staff','channels']);
  assert.throws(()=>validateCatalogPayload('other',{}),/không hợp lệ/i);
});

test('catalog validation rejects unknown fields and malformed business values', () => {
  assert.deepEqual(validateCatalogPayload('clients',{name:' Công ty A ',active:true,email:'a@example.com'}),{name:'Công ty A',email:'a@example.com',active:true});
  assert.throws(()=>validateCatalogPayload('clients',{name:'A',secret:'x'}),/không được phép/i);
  assert.throws(()=>validateCatalogPayload('clients',{name:'A',email:'bad'}),/Email/);
  assert.throws(()=>validateCatalogPayload('brands',{name:'A',client_code:'KH00001',start_date:'2026-12-01',end_date:'2026-01-01'}),/Ngày kết thúc/);
  assert.throws(()=>validateCatalogPayload('channels',{name:'A',follower:-1}),/không âm/);
});

test('client create is transactional, audited and never deletes business data', async () => {
  const calls=[];
  const db={query:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.includes('select client_code code')) return {rows:[]};
    if(sql.includes('where client_code=$1 limit 1')) return {rows:[]};
    if(sql.includes('insert into clients')) return {rows:[{id:'00000000-0000-0000-0000-000000000001',code:'KH00001',client_code:'KH00001',name:'Công ty A',active:true,change_version:1}]};
    if(sql.includes('select status from report_link_registry')) return {rows:[{status:'active'}]};
    return {rows:[]};
  }};
  const result=await createCatalogRow(db,'clients',{name:'Công ty A',active:true},'test-admin');
  assert.equal(result.row.code,'KH00001');
  assert.ok(calls.some(call=>call.sql==='begin'));
  assert.ok(calls.some(call=>call.sql.includes('admin_catalog_audit')));
  assert.ok(calls.some(call=>call.sql==='commit'));
  assert.equal(calls.some(call=>/^delete\s/i.test(call.sql.trim())),false);
});

test('database CONFIG snapshot preserves the four existing employee CONFIG blocks', async () => {
  let index=0;
  const responses=[
    [{brand_code:'CH001',name:'Brand',group_name:'Nhóm',client_name:'Khách',client_code:'KH00001',start_date:'2026-01-01',end_date:'',status:'Đang thực hiện'}],
    [{channel_code:'CH001',name:'Kênh',username:'kenh',url:'https://example.com',owner_name:'Nhân sự'}],
    [{nv_id:'NV01',name:'Nhân sự',role:'Content',phone:'',email:'',channels_count:1,base_salary:'1000000'}],
    [{min_snapshot_view:100000,amount_fulltime:200000,amount_parttime:100000}]
  ];
  const db={query:async()=>({rows:responses[index++]})};
  const snapshot=await readDatabaseConfig(db);
  assert.equal(snapshot.authority,'database');
  assert.deepEqual(snapshot.sections.map(item=>[item.key,item.rows.length]),[['brand',1],['channel',1],['staff',1],['bonus',1]]);
  assert.match(snapshot.version,/^db-sha256:/);
  assert.deepEqual(snapshot.sections[0].rows[0].slice(0,5),['CH001','Brand','Nhóm','Khách','KH00001']);
});

test('web admin migration is additive and exposes no destructive catalog operation', () => {
  const migration=fs.readFileSync(new URL('../migrations/014_web_catalog_admin.sql',import.meta.url),'utf8');
  const server=fs.readFileSync(new URL('../src/server.mjs',import.meta.url),'utf8');
  assert.match(migration,/create table if not exists admin_catalog_audit/);
  assert.doesNotMatch(migration,/\bdelete\s+from\s+(clients|brands|staff|channels)\b/i);
  assert.doesNotMatch(server,/app\.delete\('\/api\/admin\/catalog/);
  assert.match(server,/app\.patch\('\/api\/admin\/catalog/);
});
