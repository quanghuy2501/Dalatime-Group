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

export async function refreshReportingReadModel(db) {
  const acquired = Boolean((await db.query(`select pg_try_advisory_lock(hashtext($1)) locked`, [READ_MODEL_LOCK])).rows[0]?.locked);
  if (!acquired) return { refreshed: false, reason: 'refresh-already-running' };
  const started = Date.now();
  try {
    await db.query('refresh materialized view concurrently reporting_posts_canonical');
    return { refreshed: true, durationMs: Date.now()-started, ...(await reportingReadModelSummary(db)) };
  } finally {
    await db.query(`select pg_advisory_unlock(hashtext($1))`, [READ_MODEL_LOCK]).catch(()=>{});
  }
}
