import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../src/server.mjs';
import { ACTIONS, createActionRunner, createJobWorker, enqueueJob, isAllowedAction, isAllowedWebhookAction, productionConfigPushGate, WEBHOOK_ACTIONS } from '../src/adminSync/control.mjs';
import { signWebhook, verifyWebhook, verifyWebhookDetailed } from '../src/adminSync/signature.mjs';

test('HMAC signs exact body and rejects tampering, wrong secret, and stale timestamps', () => {
  const timestamp = '1760000000000', body = '{"action":"direct_nv_sync"}', secret = 'test-secret-with-enough-entropy';
  const signature = signWebhook({ secret, timestamp, body });
  assert.equal(verifyWebhook({ secret, timestamp, body, signature, now: Number(timestamp) }), true);
  assert.equal(verifyWebhook({ secret, timestamp, body: body + ' ', signature, now: Number(timestamp) }), false);
  assert.equal(verifyWebhook({ secret: 'wrong', timestamp, body, signature, now: Number(timestamp) }), false);
  assert.equal(verifyWebhook({ secret, timestamp, body, signature, now: Number(timestamp) + 300001 }), false);
});

test('Apps Script bridge byte-to-hex HMAC is accepted without body normalization', () => {
  const timestamp = '1760000000000';
  const body = JSON.stringify({ action: 'direct_nv_sync', idempotencyKey: 'bridge-key' });
  const secret = 'bridge-secret';
  const signature = signWebhook({ secret, timestamp, body });
  assert.deepEqual(verifyWebhookDetailed({ secret, timestamp, body, signature, now: Number(timestamp) }), { ok: true, reason: null });
  assert.deepEqual(verifyWebhookDetailed({ secret, timestamp, body: `${body}\\n`, signature, now: Number(timestamp) }), { ok: false, reason: 'signature_mismatch' });
});

test('webhook verifier exposes only safe reason codes', () => {
  const common = { timestamp: '1760000000000', body: '{}', now: 1760000000000 };
  assert.equal(verifyWebhookDetailed({ ...common, signature: '00' }).reason, 'secret_missing');
  assert.equal(verifyWebhookDetailed({ ...common, secret: 's', signature: '00' }).reason, 'signature_format');
  assert.equal(verifyWebhookDetailed({ ...common, secret: 's', timestamp: 'bad', signature: '0'.repeat(64) }).reason, 'timestamp_invalid/stale');
  assert.equal(verifyWebhookDetailed({ ...common, secret: 's', body: '', signature: '0'.repeat(64) }).reason, 'body_missing');
});

test('action allowlist contains only the four documented actions', () => {
  assert.deepEqual(ACTIONS, ['config_push', 'direct_nv_sync', 'report_refresh_reconcile', 'full_pipeline']);
  for (const action of ACTIONS) assert.equal(isAllowedAction(action), true);
  assert.deepEqual(WEBHOOK_ACTIONS, [...ACTIONS, 'status']);
  assert.equal(isAllowedWebhookAction('status'), true);
  assert.equal(isAllowedAction('status'), false);
  assert.equal(isAllowedAction('shell'), false);
  assert.equal(isAllowedWebhookAction('shell'), false);
});

test('production config push gate is explicit and enqueue blocks without inserting a failed job', async () => {
  assert.equal(productionConfigPushGate({ NODE_ENV: 'production', CONFIG_PUSH_PRODUCTION: '1' }).allowed, true);
  const gate = productionConfigPushGate({ NODE_ENV: 'development' });
  assert.equal(gate.allowed, false); assert.match(gate.message, /CONFIG_PUSH_PRODUCTION=1/);
  let inserted = false;
  const db = { query: async sql => { if (sql.includes('insert into admin_sync_jobs')) inserted = true; return { rows: [] }; } };
  await assert.rejects(() => enqueueJob(db, { action: 'config_push', idempotencyKey: 'blocked-key', requestedBy: 'test' }), error => error.code === 'CONFIG_PUSH_PRODUCTION_NOT_CONFIGURED' && error.statusCode === 409);
  assert.equal(inserted, false);
});

test('enqueue uses transaction lock and returns existing idempotent job', async () => {
  const calls = [];
  const existing = { id: 'same', action: 'direct_nv_sync', status: 'succeeded' };
  const db = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('where action=$1 and idempotency_key=$2')) return { rows: [existing] };
    return { rows: [] };
  } };
  const result = await enqueueJob(db, { action: 'direct_nv_sync', idempotencyKey: 'stable-key', requestedBy: 'test' });
  assert.equal(result.duplicate, true);
  assert.equal(result.job, existing);
  assert.ok(calls.some(call => call.sql.includes('pg_advisory_xact_lock')));
  assert.ok(calls.some(call => call.sql === 'commit'));
  assert.equal(calls.some(call => call.sql.includes('insert into admin_sync_jobs')), false);
});

test('worker does not claim work when another instance owns the advisory lock', async () => {
  let ran = false, ended = false;
  const db = { query: async sql => sql.includes('pg_try_advisory_lock') ? { rows: [{ locked: false }] } : { rows: [] }, end: async () => { ended = true; } };
  const worker = createJobWorker({ dbConnector: async () => db, actionRunner: async () => { ran = true; } });
  await worker.drain();
  assert.equal(ran, false); assert.equal(ended, true);
});

test('full pipeline maps to the three actions in safe order', async () => {
  const sequence = [];
  const runner = createActionRunner({ configPush: async () => { sequence.push('config'); return {}; }, directNv: async () => { sequence.push('nv'); return {}; } });
  const db = { query: async () => { sequence.push('report'); return { rows: [{}] }; } };
  await runner('full_pipeline', { db, log: async () => {} });
  assert.deepEqual(sequence, ['config', 'nv', 'report']);
});

test('admin endpoints preserve session auth and signed webhook is independently authenticated', async t => {
  const previous = Object.fromEntries(['NODE_ENV','DASHBOARD_BASIC_USER','DASHBOARD_BASIC_PASS','AUTH_SESSION_SECRET','ADMIN_SYNC_WEBHOOK_SECRET'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { NODE_ENV: 'production', DASHBOARD_BASIC_USER: 'admin', DASHBOARD_BASIC_PASS: 'pass', AUTH_SESSION_SECRET: 'session-secret', ADMIN_SYNC_WEBHOOK_SECRET: 'webhook-secret' });
  let inserts = 0, kicks = 0;
  const db = { query: async sql => {
    if (sql.includes("count(*) filter (where status='queued')")) return { rows: [{ total: 9, queued: 2, running: 1, succeeded: 5, failed: 1, latest_job_at: '2026-09-16T00:00:00Z', latest_success_at: '2026-09-15T00:00:00Z' }] };
    if (sql.includes('where action=$1 and idempotency_key=$2') || sql.includes("status in ('queued','running')")) return { rows: [] };
    if (sql.includes('insert into admin_sync_jobs')) { inserts++; return { rows: [{ id: 'job-1', action: 'direct_nv_sync', status: 'queued' }] }; }
    return { rows: [] };
  }, end: async () => {} };
  const app = createApp({ dbConnector: async () => db, reportCustomers: [], jobWorker: { kick() { kicks++; } } });
  const server = app.listen(0); t.after(() => { server.close(); for (const [key,value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/admin/sync/status`)).status, 401);
  const body = JSON.stringify({ action: 'direct_nv_sync', idempotencyKey: 'webhook-key' });
  const timestamp = String(Date.now());
  assert.equal((await fetch(`${base}/api/admin/sync/webhook`, { method: 'POST', headers: { 'content-type':'application/json', 'x-sync-timestamp':timestamp, 'x-sync-signature':'0'.repeat(64) }, body })).status, 401);
  const statusBody = JSON.stringify({ action: 'status' });
  const statusSignature = signWebhook({ secret: 'webhook-secret', timestamp, body: statusBody });
  const statusResponse = await fetch(`${base}/api/admin/sync/webhook`, { method: 'POST', headers: { 'content-type':'application/json', 'x-sync-timestamp':timestamp, 'x-sync-signature':statusSignature }, body: statusBody });
  assert.equal(statusResponse.status, 200);
  assert.deepEqual((await statusResponse.json()).queue, { queued: 2, running: 1 });
  assert.equal(inserts, 0); assert.equal(kicks, 0);
  const signature = signWebhook({ secret: 'webhook-secret', timestamp, body });
  assert.equal((await fetch(`${base}/api/admin/sync/webhook`, { method: 'POST', headers: { 'content-type':'application/json', 'x-sync-timestamp':timestamp, 'x-sync-signature':signature }, body })).status, 202);
  assert.equal(inserts, 1); assert.equal(kicks, 1);
});

test('Apps Script exposes a signed read-only status menu action', () => {
  const source = fs.readFileSync(new URL('../apps-script/RenderSyncBridge.gs', import.meta.url), 'utf8');
  assert.match(source, /addItem\('Kiểm tra trạng thái', 'checkRenderStatus'\)/);
  assert.match(source, /callRenderWebhook_\('status', null\)/);
  assert.match(source, /computeHmacSha256Signature/);
  assert.doesNotMatch(source, /function checkRenderStatus\(\)[\s\S]*?enqueueRenderSync_\('status'\)/);
});

test('dashboard UI maps every API action and exposes status, failures, and retry', () => {
  const source = fs.readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  for (const action of ACTIONS) assert.match(source, new RegExp(`['"]${action}['"]`));
  assert.match(source, /failedSources/); assert.match(source, /data-retry-job/); assert.match(source, /\/api\/admin\/sync\/status/);
});
