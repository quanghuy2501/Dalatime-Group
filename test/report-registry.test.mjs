import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { createReportRouter } from '../src/report/routes.mjs';
import { decryptReportToken, encryptReportToken, newRegistryToken, resolveRegistryPrincipal } from '../src/report/registry.mjs';
import { hashReportToken } from '../src/report/config.mjs';
import { getBrandReportScope, getReportScope } from '../src/report/queries.mjs';
import fs from 'node:fs';

const token = 'A'.repeat(43);
const fallback = [{ scope: 'customer', clientCode: 'KH001', tokenHash: hashReportToken(token) }];

test('registry crypto round-trips without plaintext storage fields', () => {
  const key = crypto.randomBytes(32);
  const encrypted = encryptReportToken(token, key);
  assert.equal(decryptReportToken({ token_ciphertext: encrypted.tokenCiphertext, token_iv: encrypted.tokenIv, token_tag: encrypted.tokenTag }, key), token);
  assert.ok(!JSON.stringify(encrypted).includes(token));
  assert.match(newRegistryToken().tokenHash, /^[a-f0-9]{64}$/);
});

test('DB row is authoritative and scopes token to its object', async () => {
  const db = { query: async (_sql, values) => {
    assert.deepEqual(values, [hashReportToken(token)]);
    return { rows: [{ scope: 'brand', object_code: 'BR009', status: 'active' }] };
  } };
  assert.deepEqual(await resolveRegistryPrincipal(db, token, fallback), { scope: 'brand', brandCode: 'BR009', source: 'registry' });
});

test('revoked registry token and malformed tokens fail closed', async () => {
  let calls = 0;
  const db = { query: async () => { calls++; return { rows: [{ scope: 'customer', object_code: 'KH001', status: 'revoked' }] }; } };
  assert.equal(await resolveRegistryPrincipal(db, token, fallback), null);
  assert.equal(await resolveRegistryPrincipal(db, 'short', fallback), null);
  assert.equal(calls, 1);
});

test('config fallback works only for an unclaimed object', async () => {
  let claimed = false;
  const db = { query: async sql => sql.includes('token_hash') ? { rows: [] } : { rows: claimed ? [{ one: 1 }] : [] } };
  assert.equal((await resolveRegistryPrincipal(db, token, fallback)).source, 'config-fallback');
  claimed = true;
  assert.equal(await resolveRegistryPrincipal(db, token, fallback), null);
});

test('missing migration permits fallback but other DB failures fail closed', async () => {
  assert.equal((await resolveRegistryPrincipal({ query: async () => { const error = new Error('missing'); error.code = '42P01'; throw error; } }, token, fallback)).clientCode, 'KH001');
  await assert.rejects(() => resolveRegistryPrincipal({ query: async () => { throw new Error('database offline'); } }, token, fallback), /database offline/);
});

test('report page route authenticates through registry and returns 404 for missing token', async () => {
  const app = express();
  const db = { query: async (sql, values) => {
    if (sql.includes('report_link_registry')) return { rows: values?.[0] === hashReportToken(token) ? [{ scope: 'customer', object_code: 'KH001', status: 'active' }] : [] };
    if (sql.includes('select name from clients')) return { rows: [{ name: 'Customer 1' }] };
    if (sql.includes('select distinct b.name')) return { rows: [] };
    if (sql.includes('select distinct p.channel_name')) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  app.use('/report', createReportRouter({ customers: [], withDb: fn => fn(db), publicDir: new URL('../public', import.meta.url).pathname }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ok = await fetch(`${base}/report/${token}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    const missing = await fetch(`${base}/report/${'B'.repeat(43)}`);
    assert.equal(missing.status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('inactive customer and duplicate canonical brand names are denied', async () => {
  const inactiveDb = { query: async () => ({ rows: [] }) };
  assert.equal(await getReportScope(inactiveDb, 'KH-OFF'), null);
  let query = 0;
  const duplicateBrandDb = { query: async () => ++query === 1
    ? { rows: [{ brand_code: 'BR1', name: '  Da Lat   Time ', client_code: 'KH1', client_name: 'Customer' }] }
    : { rows: [{ brand_code: 'BR1' }, { brand_code: 'BR2' }] } };
  assert.equal(await getBrandReportScope(duplicateBrandDb, 'BR1'), null);
});

test('migration enforces scope/code identity, unique hashes, lifecycle and no plaintext column', () => {
  const sql = fs.readFileSync(new URL('../migrations/013_report_link_registry.sql', import.meta.url), 'utf8');
  assert.match(sql, /primary key \(scope,object_code\)/);
  assert.match(sql, /unique \(token_hash\)/);
  assert.match(sql, /status in \('active','revoked'\)/);
  assert.match(sql, /created_at[\s\S]*rotated_at[\s\S]*revoked_at/);
  assert.doesNotMatch(sql, /token_plaintext|report_path/);
});
