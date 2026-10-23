import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ANALYST_SYSTEM_PROMPT, AnalystError, buildAnalystContext, safeReply } from '../src/ai/analyst.mjs';
import { createApp } from '../src/server.mjs';

test('reporting scope labels absent rows honestly instead of declaring missed reports', async () => {
  const db = { query: async (sql) => {
    if (sql.includes('from brands where active')) return { rows: [{ id: 'b1', code: 'B1', name: 'Brand A' }] };
    if (sql.includes('from staff where active order')) return { rows: [{ id: 's1', code: 'NV01', name: 'Nguyễn An', role: 'Content' }] };
    if (sql.includes('with days as')) return { rows: [{ nv_id: 'NV01', name: 'Nguyễn An', no_post_dates: ['2026-10-22'], posts: 0 }] };
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  } };
  const context = await buildAnalystContext(db, { question: 'Ngày 22/10/2026 ai không có bài được ghi nhận?', scope: 'auto', from: '2026-10-01', to: '2026-10-23' }, new Date('2026-10-23T01:00:00Z'));
  assert.equal(context.scope, 'reporting');
  assert.match(context.facts[1].label, /không có bài/i);
  assert.match(context.limitations.join(' '), /không được gọi là vi phạm\/chưa báo cáo/i);
});

test('analyst prompt forces grounded sourced Vietnamese answers', () => {
  assert.match(ANALYST_SYSTEM_PROMPT, /tiếng Việt có dấu đầy đủ/i);
  assert.match(ANALYST_SYSTEM_PROMPT, /Không bịa số/i);
  assert.match(ANALYST_SYSTEM_PROMPT, /\[S1\]/);
  assert.match(ANALYST_SYSTEM_PROMPT, /thiếu target/i);
});

test('analyst rejects long Vietnamese answers without diacritics so caller can use fallback model', () => {
  assert.throws(() => safeReply({ title: 'Phan tich van hanh', answer: 'Du lieu van hanh duoc phan tich dung theo cac nguon da cung cap trong he thong va khong duoc phep tu y ket luan khi chua co du lieu.', findings: ['Can kiem tra them du lieu nguon.'] }, new Set()), error => error instanceof AnalystError && error.details.providerStatus === 'invalid_locale');
  const reply = safeReply({ title: 'Phân tích vận hành', answer: 'Dữ liệu vận hành được phân tích đúng theo nguồn.', findings: [] }, new Set());
  assert.match(reply.title, /Phân tích/);
});

test('AI endpoint is admin-only and never available to bearer service token', async t => {
  const previous = Object.fromEntries(['NODE_ENV','DASHBOARD_BASIC_USER','DASHBOARD_BASIC_PASS','DASHBOARD_AUTH_TOKEN','AUTH_SESSION_SECRET'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { NODE_ENV: 'production', DASHBOARD_BASIC_USER: 'admin', DASHBOARD_BASIC_PASS: 'secret', DASHBOARD_AUTH_TOKEN: 'service', AUTH_SESSION_SECRET: 'test-secret' });
  let calls = 0;
  const db = { end: async () => {} };
  const app = createApp({ reportCustomers: [], jobWorker: { kick() {} }, dbConnector: async () => db, analystService: async () => { calls++; return { ok: true, reply: { answer: 'Có nguồn [S1].' }, context: {}, sources: [] }; } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.close(); for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const url = `http://127.0.0.1:${server.address().port}/api/ai/analyst`;
  const unauth = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauth.status, 401);
  const bearer = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer service' }, body: '{}' });
  assert.equal(bearer.status, 403);
  const basic = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` }, body: JSON.stringify({ question: 'Kiểm tra vận hành' }) });
  assert.equal(basic.status, 200);
  assert.equal(calls, 1);
});

test('AI audit migration is append-only and blocks public API roles', () => {
  const migration = fs.readFileSync(new URL('../migrations/019_ai_analyst_audit.sql', import.meta.url), 'utf8');
  assert.match(migration, /before update or delete/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table ai_analyst_audit from anon, authenticated/i);
  assert.doesNotMatch(migration, /question\s+text/i);
});
