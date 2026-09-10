import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('scripts/master_snapshot.py', 'utf8');

test('snapshot Google client exposes GET only and requests readonly scopes', () => {
  assert.match(source, /spreadsheets\.readonly/);
  assert.match(source, /drive\.metadata\.readonly/);
  assert.match(source, /method="GET"/);
  assert.doesNotMatch(source, /method="(?:PUT|PATCH|DELETE)"/);
});

test('snapshot is full-range, fingerprints data, and locks only complete exports', () => {
  assert.match(source, /!A:ZZ/);
  assert.doesNotMatch(source, /1500/);
  assert.match(source, /hashlib\.sha256/);
  assert.match(source, /"locked": complete/);
  assert.match(source, /"status": "complete" if complete else "partial"/);
  assert.match(source, /master_dimensions/);
});

test('auditor covers required discrepancy keys', () => {
  assert.match(source, /"post_url"/);
  assert.match(source, /"post_url,brand"/);
  assert.match(source, /"staff_id,status"/);
});
