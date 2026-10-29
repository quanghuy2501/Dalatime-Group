const READ_MODEL_LOCK = 'onicorn:reporting-read-model-refresh';

export async function reportingReadModelSummary(db) {
  return (await db.query(`select
    (select count(*)::int from posts_raw_sheet) source_rows,
    (select count(*)::int from reporting_posts_canonical) canonical_rows,
    (select count(*)::int from reporting_posts_canonical where posted_date_parse_ok and posted_date>current_date) future_rows,
    (select count(*)::int from reporting_posts_canonical where not posted_date_parse_ok or posted_date is null) invalid_date_rows,
    (select coalesce(sum(source_row_count-1),0)::int from reporting_posts_canonical) duplicate_source_rows,
    (select max(updated_at) from reporting_posts_canonical) source_watermark`)).rows[0];
}

export async function refreshReportingReadModel(db, { statementTimeoutMs=120000, lockTimeoutMs=30000 }={}) {
  const started = Date.now();
  await db.query('begin');
  try {
    await db.query(`select set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)`, [String(Math.max(1000,statementTimeoutMs)),String(Math.max(1000,lockTimeoutMs))]);
    const acquired = Boolean((await db.query(`select pg_try_advisory_xact_lock(hashtext($1)) locked`, [READ_MODEL_LOCK])).rows[0]?.locked);
    if (!acquired) { await db.query('rollback'); return { refreshed: false, reason: 'refresh-already-running' }; }
    // Transaction-pool safe: the xact lock and refresh stay on one backend.
    // The bounded non-concurrent refresh avoids leaked session advisory locks
    // and unbounded concurrent refreshes on Supavisor transaction mode.
    await db.query('refresh materialized view reporting_posts_canonical');
    const summary = await reportingReadModelSummary(db);
    await db.query('commit');
    return { refreshed: true, durationMs: Date.now()-started, ...summary };
  } catch (error) {
    await db.query('rollback').catch(()=>{});
    throw error;
  }
}
