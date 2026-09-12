import test from 'node:test';
import assert from 'node:assert/strict';
import { engagementRateFromMetrics, formatEngagementPercent, normalizeEngagementRate } from '../src/utils/normalize.mjs';
import { mapPostRaw } from '../src/importers/liveMaster.mjs';

test('ratio and legacy percent values both present as 4.82%', () => {
  assert.equal(normalizeEngagementRate(0.0482), 0.0482);
  assert.equal(normalizeEngagementRate(4.82), 0.0482);
  assert.equal(formatEngagementPercent(0.0482), '4.82%');
  assert.equal(formatEngagementPercent(4.82), '4.82%');
});

test('zero-view ER is zero', () => {
  assert.equal(engagementRateFromMetrics({ view: 0, like: 20, comment: 3, save: 2, share: 1 }), 0);
});

test('aggregate ER uses total interactions divided by total views', () => {
  const rows = [
    { view: 100, like: 3, comment: 1, save: 0, share: 1 },
    { view: 400, like: 12, comment: 2, save: 3, share: 2 }
  ];
  const totals = rows.reduce((a, row) => Object.fromEntries(Object.keys(a).map(key => [key, a[key] + row[key]])), { view:0, like:0, comment:0, save:0, share:0 });
  assert.equal(engagementRateFromMetrics(totals), 24 / 500);
  assert.notEqual(engagementRateFromMetrics(totals), rows.reduce((sum, row) => sum + engagementRateFromMetrics(row), 0) / rows.length);
});

test('Master mapping derives canonical ER from stored metrics, not source display shape', () => {
  const base = { __row:2, __values:[], 'NGÀY ĐĂNG BÀI':'2026-09-01', 'LINK BÀI ĐĂNG':'https://example.com/p', 'TÊN KÊNH':'K', VIEW:1000, LIKE:40, COMMENT:3, SAVE:2, SHARE:3 };
  assert.equal(mapPostRaw({ ...base, '% TƯƠNG TÁC':0.0482 }).engagement_rate, 0.048);
  assert.equal(mapPostRaw({ ...base, '% TƯƠNG TÁC':4.82 }).engagement_rate, 0.048);
});
