import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mapPostRaw } from '../src/importers/liveMaster.mjs';
import { getOverview, getPosts } from '../src/db/queries.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/posts-mapping.json', import.meta.url)));

test('Apps Script RAW_DATA fields map to the complete Posts API contract', () => {
  const actual = mapPostRaw({ __row: 2, __values: [], ...fixture.source });
  for (const [field, value] of Object.entries(fixture.expected)) assert.equal(actual[field], value, field);
});

test('Posts query exposes canonical brands, every engagement metric, flags, URL, and post-date filters', async () => {
  const calls = [];
  const db = { query: async (sql, vals) => {
    calls.push({ sql, vals });
    return /count\(\*\)::int count/.test(sql) ? { rows: [{ count: 1 }] } : { rows: [{ ...fixture.expected, brand_names: 'Dalat Review, Dalat Time' }] };
  } };
  const result = await getPosts(db, { from: '2026-09-01', to: '2026-09-12', brand: 'Dalat', sort: 'er' });
  assert.equal(result.rows[0].brand_names, 'Dalat Review, Dalat Time');
  for (const field of ['posted_date','channel_name','owner_name','post_url','realtime_view','realtime_like','realtime_comment','realtime_save','realtime_share','is_exclusive','viral_label','engagement_rate']) {
    assert.match(calls[0].sql, new RegExp(`p\\.${field}|as ${field}`), field);
  }
  assert.match(calls[0].sql, /p\.posted_date::text as posted_date/, 'DATE must stay YYYY-MM-DD across JSON/timezones');
  assert.match(calls[0].sql, /p\.posted_date >=/);
  assert.match(calls[0].sql, /p\.posted_date <=/);
  assert.match(calls[0].sql, /post_brands_sheet/);
});

test('overview computes weighted aggregate ER and bounds rolling seven days at today', async () => {
  let captured = '';
  const db = { query: async sql => { captured = sql; return { rows: [{ view: 500, interactions: 24, er: 0.048 }] }; } };
  const row = await getOverview(db);
  assert.equal(Number(row.er), Number(row.interactions) / Number(row.view));
  assert.match(captured, /between current_date - interval '6 days' and current_date/);
});
