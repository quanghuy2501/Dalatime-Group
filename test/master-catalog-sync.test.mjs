import test from 'node:test';
import assert from 'node:assert/strict';
import { planClientReconciliation, prepareMasterCatalog, publishMasterCatalog } from '../src/catalog/masterCatalog.mjs';

const snapshot = (clients, brands) => ({
  clients: [['MÃ KH', 'TÊN THƯƠNG HIỆU/ CÔNG TY', 'TRẠNG THÁI'], ...clients].slice(1).map((row, index) => ({
    __row: index + 5, __values: row, 'MÃ KH': row[0], 'TÊN THƯƠNG HIỆU/ CÔNG TY': row[1], 'TRẠNG THÁI': row[2]
  })),
  brands: [['ID BRAND', 'TÊN THƯƠNG HIỆU', 'MÃ KH', 'TRẠNG THÁI'], ...brands].slice(1).map((row, index) => ({
    __row: index + 5, __values: row, 'ID BRAND': row[0], 'TÊN THƯƠNG HIỆU': row[1], 'MÃ KH': row[2], 'TRẠNG THÁI': row[3]
  }))
});

test('prepares a valid catalog and preserves legacy duplicate client codes with distinct names', () => {
  const result = prepareMasterCatalog(snapshot(
    [['KH00083', 'Tên cũ A', 'Đang thực hiện'], ['KH00083', 'Tên cũ B', 'Đang thực hiện'], ['KH00151', 'NHÂM', 'Đang thực hiện']],
    [['CH176', 'NHÂM', 'KH00151', 'Đang thực hiện']]
  ));
  assert.equal(result.clients.length, 3);
  assert.equal(result.brands.length, 1);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
});

test('fails closed on duplicate brand codes and orphan brands', () => {
  assert.throws(() => prepareMasterCatalog(snapshot(
    [['KH01', 'One', 'Đang thực hiện']],
    [['CH01', 'One', 'KH01', 'Đang thực hiện'], ['CH01', 'Two', 'KH01', 'Đang thực hiện']]
  )), /Trùng ID BRAND/);
  assert.throws(() => prepareMasterCatalog(snapshot(
    [['KH01', 'One', 'Đang thực hiện']],
    [['CH02', 'Two', 'KH99', 'Đang thực hiện']]
  )), /không có khách hàng/i);
});

test('reconciliation updates exact identities and inserts new customers idempotently', () => {
  const source = [
    { client_code: 'KH00083', name: 'Tên A' },
    { client_code: 'KH00083', name: 'Tên B' },
    { client_code: 'KH00151', name: 'NHÂM' }
  ];
  const existing = [
    { id: 'a', client_code: 'KH00083', name: 'Tên A' },
    { id: 'b', client_code: 'KH00083', name: 'Tên B' }
  ];
  const plan = planClientReconciliation(source, existing);
  assert.deepEqual(plan.updates.map(row => row.id), ['a', 'b']);
  assert.deepEqual(plan.inserts.map(row => row.client_code), ['KH00151']);
  const rerun = planClientReconciliation(source, [...existing, { id: 'c', client_code: 'KH00151', name: 'NHÂM' }]);
  assert.equal(rerun.inserts.length, 0);
  assert.equal(rerun.updates.length, 3);
});

test('reconciliation supports an unambiguous rename but rejects ambiguous duplicate-code drift', () => {
  const rename = planClientReconciliation([{ client_code: 'KH01', name: 'Tên mới' }], [{ id: 'a', client_code: 'KH01', name: 'Tên cũ' }]);
  assert.equal(rename.updates[0].id, 'a');
  assert.throws(() => planClientReconciliation(
    [{ client_code: 'KH01', name: 'Tên mới A' }, { client_code: 'KH01', name: 'Tên mới B' }],
    [{ id: 'a', client_code: 'KH01', name: 'Tên cũ A' }, { id: 'b', client_code: 'KH01', name: 'Tên cũ B' }]
  ), /đối soát an toàn/);
});

test('publisher commits one atomic catalog run', async () => {
  const calls = [];
  const db = { query: async (sql, args) => {
    calls.push([sql, args]);
    if (/returning id/.test(sql)) return { rows: [{ id: 'run-1' }] };
    if (/select id,client_code,name/.test(sql)) return { rows: [] };
    return { rows: [] };
  } };
  const result = await publishMasterCatalog(db, {
    fingerprint: 'abc',
    clients: [{ client_code: 'KH01', name: 'One', status: 'Đang thực hiện', contact_name: '', report_file_id: null, raw_row: [], active: true }],
    brands: [{ brand_code: 'CH01', name: 'One', client_code: 'KH01', client_name: 'One', group_name: '', status: 'Đang thực hiện', raw_row: [], active: true }]
  });
  assert.equal(result.insertedClients, 1);
  assert.equal(calls[0][0], 'begin');
  assert.equal(calls.at(-1)[0], 'commit');
  assert.ok(calls.some(([sql]) => /on conflict\(brand_code\)/.test(sql)));
});

test('publisher rolls back and records a failed run', async () => {
  const calls = [];
  const db = { query: async (sql, args) => {
    calls.push([sql, args]);
    if (/returning id/.test(sql)) return { rows: [{ id: 'run-1' }] };
    if (/select id,client_code,name/.test(sql)) return { rows: [] };
    if (/insert into brands/.test(sql)) throw new Error('brand write failed');
    return { rows: [] };
  } };
  await assert.rejects(() => publishMasterCatalog(db, {
    fingerprint: 'abc', clients: [],
    brands: [{ brand_code: 'CH01', name: 'One', client_code: 'KH01', client_name: 'One', group_name: '', status: 'Đang thực hiện', raw_row: [], active: true }]
  }), /brand write failed/);
  assert.ok(calls.some(([sql]) => sql === 'rollback'));
  assert.ok(calls.some(([sql, args]) => /values\(\$1,'fail'/.test(sql) && args?.[0] === 'master_catalog_sync'));
});
