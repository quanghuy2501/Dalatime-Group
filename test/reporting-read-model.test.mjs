import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { refreshReportingReadModel } from '../src/reporting/readModel.mjs';

const migration=fs.readFileSync(new URL('../migrations/015_canonical_reporting_read_model.sql',import.meta.url),'utf8');
const security=fs.readFileSync(new URL('../migrations/016_lock_public_database_roles.sql',import.meta.url),'utf8');

test('canonical reporting migration is additive, traceable and excludes future dates only in the read view',()=>{
  assert.match(migration,/create materialized view reporting_posts_canonical/i);
  assert.match(migration,/source_row_keys/);
  assert.match(migration,/array_agg\(brand_name order by brand_key\)/);
  assert.match(migration,/posted_date is null or posted_date <= current_date/i);
  assert.doesNotMatch(migration,/\b(update|delete from|truncate)\s+(posts_raw_sheet|post_brands_sheet)\b/i);
});

test('public database lock revokes Supabase API roles and enables RLS without business-row writes',()=>{
  assert.match(security,/rolname in \('anon','authenticated'\)/i);
  assert.match(security,/revoke all privileges/i);
  assert.match(security,/enable row level security/i);
  assert.doesNotMatch(security,/\b(update|delete from|truncate table|insert into)\s+(clients|brands|staff|channels|posts_raw_sheet|post_brands_sheet)\b/i);
});

test('read-model refresh is singleton, concurrent and returns parity metadata',async()=>{
  const calls=[];
  const db={query:async(sql)=>{
    calls.push(sql);
    if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
    if(sql.includes('source_rows'))return {rows:[{source_rows:10,canonical_rows:7,future_rows:1,duplicate_source_rows:3}]};
    return {rows:[{}]};
  }};
  const result=await refreshReportingReadModel(db);
  assert.equal(result.refreshed,true);
  assert.equal(result.canonical_rows,7);
  assert.ok(calls.some(sql=>sql.includes('refresh materialized view concurrently reporting_posts_canonical')));
  assert.ok(calls.some(sql=>sql.includes('pg_advisory_unlock')));
});
