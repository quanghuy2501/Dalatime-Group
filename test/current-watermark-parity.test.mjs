import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalMaster, canonicalPostUrl, compareKeySets } from '../src/reconciliation/currentWatermarkParity.mjs';
import { mapStaff } from '../src/importers/liveMaster.mjs';

const sheet = values => ({ values });
const snapshot = {
  status: 'complete', locked: true, sources: {
    clients: sheet([['TITLE'], [], ['MÃ KH','TÊN THƯƠNG HIỆU/ CÔNG TY','TRẠNG THÁI'], ['KH01','Acme','Đang thực hiện'], ['note','','']]),
    staff: sheet([['ID NHÂN VIÊN','TÊN NHÂN VIÊN','TÌNH TRẠNG'], ['NV01','An','Đang làm'], ['NV02','Binh','Đã nghỉ'], ['', '', '']]),
    channels: sheet([['ID CHANNEL','TÊN KÊNH'], ['CH01','One'], ['bad','Instruction']]),
    brands: sheet([['ID BRAND','TÊN THƯƠNG HIỆU','MÃ KH','TRẠNG THÁI'], ['CH01','Acme','KH01','Đang thực hiện']]),
    raw_data: sheet([['REPORT'], ['LINK BÀI ĐĂNG'], ['https://TikTok.com/a/?x=1'], ['https://tiktok.com/a#x'], ['']]),
    normalized: sheet([['TÊN THƯƠNG HIỆU','LINK BÀI ĐĂNG'], [' Acme ','https://TikTok.com/a/?x=1'], ['acme','https://tiktok.com/a#x'], ['','']])
  }
};

test('canonical URL strips query/hash/trailing slash and folds case', () => {
  assert.equal(canonicalPostUrl(' HTTPS://TikTok.com/A/?x=1#z '), 'https://tiktok.com/a');
});

test('canonical master removes scaffolding and invalid records and distincts post keys', () => {
  const result = canonicalMaster(snapshot);
  assert.equal(result.clients.keys.length, 1);
  assert.equal(result.staff.keys.length, 2);
  assert.equal(result.channels.keys.length, 1);
  assert.equal(result.raw_data.keys.length, 1);
  assert.equal(result.normalized.keys.length, 1);
  assert.equal(result.raw_data.dropped.empty, 1);
});

test('gate fails closed on a real distinct key and reports exact lists', () => {
  const master = canonicalMaster(snapshot);
  const database = Object.fromEntries(Object.entries(master).map(([name, value]) => [name, [...value.keys]]));
  assert.equal(Object.values(compareKeySets(master, database)).some(c => c.missing_count || c.extra_count), false);
  database.normalized = [];
  const checks = compareKeySets(master, database);
  assert.equal(checks.normalized.missing_count, 1);
  assert.deepEqual(checks.normalized.missing, [['https://tiktok.com/a','acme']]);
});

test('staff importer uses the live sheet TÌNH TRẠNG status column', () => {
  assert.equal(mapStaff({ 'ID NHÂN VIÊN': 'NV02', 'TÊN NHÂN VIÊN': 'Binh', 'TÌNH TRẠNG': 'Đã nghỉ', __values: [] }).active, false);
});
