import test from 'node:test';
import assert from 'node:assert/strict';
import { loadServiceAccount } from '../src/google/serviceAccountAuth.mjs';

const ENV_NAMES = ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_APPLICATION_CREDENTIALS_JSON', 'GOOGLE_SERVICE_ACCOUNT_JSON'];
const withCredentialEnv = (values, fn) => {
  const before = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try { return fn(); } finally {
    for (const name of ENV_NAMES) before[name] === undefined ? delete process.env[name] : process.env[name] = before[name];
  }
};

test('falls back to service-account JSON env when credential file is unreadable', () => {
  const key = { client_email: 'config-push@example.test', private_key: 'test-private-key', project_id: 'test-project' };
  withCredentialEnv({ GOOGLE_APPLICATION_CREDENTIALS: '/does/not/exist.json', GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify(key) }, () => {
    assert.deepEqual(loadServiceAccount(), key);
  });
});

test('accepts the GOOGLE_SERVICE_ACCOUNT_JSON alias', () => {
  const key = { client_email: 'config-push@example.test', private_key: 'test-private-key' };
  withCredentialEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(key) }, () => assert.deepEqual(loadServiceAccount(), key));
});

test('fails safely when no service-account credential is available', () => {
  withCredentialEnv({}, () => assert.throws(() => loadServiceAccount(), /credentials unavailable/));
});
