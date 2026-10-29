import pg from 'pg';
const { Client, Pool } = pg;

export function normalizeDatabaseUrl(connectionString, { sessionPooler=false }={}) {
  if (!connectionString || !sessionPooler) return connectionString;
  const url=new URL(connectionString);
  if (url.port==='6543' && url.hostname.endsWith('.pooler.supabase.com')) url.port='5432';
  return url.toString();
}

function connectionConfig() {
  const connectionString = normalizeDatabaseUrl(process.env.DATABASE_URL,{sessionPooler:process.env.DB_USE_SESSION_POOLER==='1'});
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
  return config;
}

export async function connectDb() {
  const config = connectionConfig();
  const client = new Client(config);
  await client.connect();
  return client;
}

let appPool;
function getAppPool() {
  if (appPool) return appPool;
  appPool = new Pool({
    ...connectionConfig(),
    max: Math.max(1, Number(process.env.DB_POOL_MAX || 3)),
    connectionTimeoutMillis: Math.max(1000, Number(process.env.DB_CONNECT_TIMEOUT_MS || 15000)),
    idleTimeoutMillis: Math.max(1000, Number(process.env.DB_IDLE_TIMEOUT_MS || 30000)),
    allowExitOnIdle: true
  });
  appPool.on('error', error => console.error(`[database-pool] idle client error: ${error.message}`));
  return appPool;
}

// Web requests share a small, bounded pool instead of creating an unbounded
// burst of authenticated Supavisor sessions. The returned lease preserves the
// existing query/end contract used throughout the server and job worker.
export async function connectAppDb() {
  const client = await getAppPool().connect();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    client.release();
  };
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'end') return release;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
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
