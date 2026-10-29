import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/server.mjs';

test('dashboard uses one database lease for the complete payload', async t => {
  const keys = ['NODE_ENV', 'DASHBOARD_BASIC_USER', 'DASHBOARD_BASIC_PASS', 'AUTH_SESSION_SECRET'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    NODE_ENV: 'production',
    DASHBOARD_BASIC_USER: 'admin',
    DASHBOARD_BASIC_PASS: 'secret',
    AUTH_SESSION_SECRET: 'test-secret'
  });
  let connections = 0;
  let releases = 0;
  const db = {
    query: async () => ({ rows: [] }),
    end: async () => { releases += 1; }
  };
  const app = createApp({
    reportCustomers: [],
    jobWorker: { kick() {} },
    dbConnector: async () => { connections += 1; return db; }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => {
    server.close();
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard`, {
    headers: { authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` }
  });
  assert.equal(response.status, 200);
  assert.equal(connections, 1);
  assert.equal(releases, 1);
});
