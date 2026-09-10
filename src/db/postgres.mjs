import pg from 'pg';
const { Client } = pg;
export async function connectDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Missing DATABASE_URL');
  const config = { connectionString, ssl: connectionString.includes('supabase.com') || process.env.SUPABASE_POOLER_IP ? { rejectUnauthorized: false } : undefined };
  if (process.env.SUPABASE_POOLER_IP) {
    const u = new URL(connectionString);
    config.host = process.env.SUPABASE_POOLER_IP;
    config.port = Number(u.port || 5432);
    config.user = decodeURIComponent(u.username);
    config.password = decodeURIComponent(u.password);
    config.database = u.pathname.replace(/^\//, '') || 'postgres';
  }
  const client = new Client(config);
  await client.connect();
  return client;
}
export async function runSqlFile(client, filePath) {
  const fs = await import('fs');
  await client.query(fs.readFileSync(filePath, 'utf8'));
}
export async function upsert(client, table, rows, conflictCols, updateCols, options = {}) {
  if (!rows.length) return 0;
  const maxParams = options.maxParams || 50000;
  let total = 0;
  for (let offset = 0; offset < rows.length;) {
    const keys = Object.keys(rows[offset]);
    const chunkSize = Math.max(1, Math.min(rows.length - offset, Math.floor(maxParams / keys.length)));
    const chunkRows = rows.slice(offset, offset + chunkSize);
    const values = [];
    const chunks = chunkRows.map((row, ri) => '(' + keys.map((k, ki) => { values.push(row[k]); return `$${ri * keys.length + ki + 1}`; }).join(',') + ')').join(',');
    const updates = updateCols.map(c => `${c}=excluded.${c}`).join(', ');
    const updatedAt = options.noUpdatedAt || updateCols.includes('updated_at') ? '' : ', updated_at=now()';
    const sql = options.plainInsert
      ? `insert into ${table} (${keys.join(',')}) values ${chunks}`
      : `insert into ${table} (${keys.join(',')}) values ${chunks} on conflict (${conflictCols.join(',')}) do update set ${updates}${updatedAt}`;
    await client.query(sql, values);
    total += chunkRows.length;
    offset += chunkSize;
  }
  return total;
}
