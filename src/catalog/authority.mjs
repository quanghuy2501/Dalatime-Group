export async function isDatabaseCatalogAuthority(db, env = process.env) {
  if (env.CATALOG_AUTHORITY === 'master') return false;
  if (env.CATALOG_AUTHORITY === 'database') return true;
  if (env.NODE_ENV !== 'production') return false;
  try {
    const result = await db.query(`select exists(
      select 1 from sync_runs where run_type='catalog_authority_cutover' and status='ok'
    ) enabled`);
    return Boolean(result.rows[0]?.enabled);
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') return false;
    throw error;
  }
}
