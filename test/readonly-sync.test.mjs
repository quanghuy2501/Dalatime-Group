import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync('scripts/run-readonly-sync-cycle.mjs', 'utf8');
test('readonly cycle never invokes migration or mutating phases', () => {
  assert.doesNotMatch(source, /phase1-import-master-to-db|phase1:import/);
  assert.doesNotMatch(source, /--migrate/);
  assert.doesNotMatch(source, /phase22-import|phase15-generate|phase15-calc/);
  assert.match(source, /DRY_RUN: ['"]1['"]/);
  assert.match(source, /READONLY_SYNC: ['"]1['"]/);
});
test('readonly cycle loads local env and propagates it to child', () => {
  assert.match(source, /loadEnv\(\)/);
  assert.match(source, /env, cwd/);
});
test('readonly cycle uses repo-local exporter and fixture mode by default', () => {
  assert.match(source, /scripts.*master_snapshot\.py/s);
  assert.match(source, /READONLY_LIVE === '1'/);
  assert.match(source, /--fixture-dir/);
  assert.doesNotMatch(source, /report-os|aicoworker/);
});
