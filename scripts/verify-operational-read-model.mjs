import { connectDb } from '../src/db/postgres.mjs';
import { getOverview } from '../src/db/queries.mjs';
import { getReportOverview } from '../src/report/queries.mjs';

const db=await connectDb();
const started=Date.now();
try{
  const counts=(await db.query(`select
    (select count(*)::int from posts_raw_sheet) source_rows,
    (select count(distinct case when nullif(trim(post_url),'') is null then row_key else regexp_replace(regexp_replace(lower(trim(post_url)),'\\?.*$',''),'/$','') end)::int from posts_raw_sheet) source_canonical_keys,
    (select count(*)::int from reporting_posts_canonical) canonical_rows,
    (select count(*)::int from reporting_posts_current) current_rows,
    (select count(*)::int from reporting_posts_canonical where posted_date_parse_ok and posted_date>current_date) future_rows,
    (select count(*)::int from reporting_posts_canonical where not posted_date_parse_ok or posted_date is null) invalid_date_rows,
    (select count(*)::int from reporting_posts_canonical where source_row_count<>cardinality(source_row_keys) or not(row_key=any(source_row_keys))) trace_errors`)).rows[0];
  const security=(await db.query(`select
    (select count(*)::int from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated')) exposed_grants,
    (select count(*)::int from pg_tables where schemaname='public') tables_total,
    (select count(*)::int from pg_tables where schemaname='public' and rowsecurity) rls_enabled`)).rows[0];
  const representative=(await db.query(`select client_code from brands where active and client_code is not null group by client_code order by count(*) desc,client_code limit 1`)).rows[0]?.client_code;
  const overviewStarted=Date.now(),overview=await getOverview(db),overviewMs=Date.now()-overviewStarted;
  const reportStarted=Date.now(),report=representative?await getReportOverview(db,representative):null,reportMs=Date.now()-reportStarted;
  const today=new Date().toISOString().slice(0,10);
  const reportDate=report?.date_to instanceof Date?report.date_to.toISOString().slice(0,10):String(report?.date_to||'').slice(0,10);
  const checks={
    canonical_key_parity:Number(counts.source_canonical_keys)===Number(counts.canonical_rows),
    excluded_rows_reconcile:Number(counts.current_rows)+Number(counts.future_rows)+Number(counts.invalid_date_rows)===Number(counts.canonical_rows),
    source_trace_complete:Number(counts.trace_errors)===0,
    overview_count_matches:Number(overview.posts)===Number(counts.current_rows),
    public_roles_locked:Number(security.exposed_grants)===0,
    rls_complete:Number(security.tables_total)===Number(security.rls_enabled),
    report_date_bounded:!reportDate||reportDate<=today,
    overview_under_5s:overviewMs<5000,
    representative_report_under_5s:reportMs<5000
  };
  const ok=Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ok,readOnly:true,generatedAt:new Date().toISOString(),durationMs:Date.now()-started,counts,security,performance:{overviewMs,reportMs,representative},checks},null,2));
  if(!ok)process.exitCode=1;
}finally{await db.end();}
