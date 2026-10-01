import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectDb } from './db/postgres.mjs';
import { authMiddleware, credentialsMatch, createSessionCookie, clearSessionCookie } from './auth.mjs';
import { getOverview, getTopBrands, getTopStaff, getTopChannels, getPosts, getHealth, getTimeseries, getIssues, getIssueTypes, getMasters, getAlerts, getHeatmap } from './db/queries.mjs';
import { loadReportCustomers } from './report/config.mjs';
import { createReportApiRouter, createReportRouter } from './report/routes.mjs';
import { decryptReportToken, registryKey } from './report/registry.mjs';
import { createJobWorker, enqueueJob, isAllowedWebhookAction, retryJob, syncStatus, WEBHOOK_STATUS_ACTION, webhookStatus } from './adminSync/control.mjs';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyWebhookDetailed } from './adminSync/signature.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4177);
const publicDir = path.join(__dirname, '..', 'public');
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
function asInt(v, fallback) { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : fallback; }
function validRange(query) {
  const date = v => !v || /^\d{4}-\d{2}-\d{2}$/.test(String(v));
  return date(query.from) && date(query.to) && !(query.from && query.to && query.from > query.to);
}

export function createApp({ dbConnector = connectDb, reportCustomers, jobWorker } = {}) {
const app = express();
jobWorker ||= createJobWorker({ dbConnector });
app.locals.jobWorker = jobWorker;
if (reportCustomers === undefined) {
  try { reportCustomers = loadReportCustomers(); }
  catch (error) { console.error(`Report config unavailable: ${error.message}`); reportCustomers = []; }
}
app.get('/healthz', (req, res) => res.json({ ok: true, service: 'onicorn-dashboard-system', readiness: 'process-live' }));
app.get('/readyz', asyncRoute(async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(503).json({ ok: false, ready: false, reason: 'DATABASE_URL missing' });
  try { await appWithDb(async db => db.query('select 1')); res.json({ ok: true, ready: true }); }
  catch { res.status(503).json({ ok: false, ready: false, reason: 'database unavailable' }); }
}));
const appWithDb = async fn => {
  const db = await dbConnector();
  try { return await fn(db); } finally { await db.end(); }
};
app.use(cors());
app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = buffer.toString('utf8'); } }));
app.use(express.urlencoded({ extended: false }));
app.get('/login', (req, res) => res.sendFile(path.join(publicDir, 'login.html')));
app.post('/auth/login', (req, res) => {
  if (!process.env.AUTH_SESSION_SECRET) return res.status(503).json({ ok: false, error: 'AUTH_SESSION_SECRET is not configured' });
  if (!credentialsMatch(String(req.body.username || ''), String(req.body.password || ''))) return res.status(401).json({ ok: false, error: 'Tên đăng nhập hoặc mật khẩu không đúng' });
  res.setHeader('Set-Cookie', createSessionCookie());
  res.json({ ok: true, redirect: '/' });
});
app.post('/auth/logout', (req, res) => { res.setHeader('Set-Cookie', clearSessionCookie()); res.json({ ok: true }); });
app.post('/api/admin/sync/webhook', asyncRoute(async (req, res) => {
  const timestamp = req.get(TIMESTAMP_HEADER);
  const signature = req.get(SIGNATURE_HEADER);
  const verification = verifyWebhookDetailed({ secret: process.env.ADMIN_SYNC_WEBHOOK_SECRET, timestamp, signature, body: req.rawBody });
  if (!verification.ok) {
    // Deliberately log and return only a bounded reason code. Never include secret, body, token, or signature.
    console.warn(`[admin-sync] webhook rejected: ${verification.reason}`);
    return res.status(401).json({ ok: false, error: 'Invalid or expired webhook signature', reason: verification.reason });
  }
  const action = req.body?.action;
  if (!isAllowedWebhookAction(action)) return res.status(400).json({ ok: false, error: 'Action is not allowlisted' });
  if (action === WEBHOOK_STATUS_ACTION) {
    try {
      return res.json({ ok: true, ...(await appWithDb(webhookStatus)) });
    } catch (error) {
      // This signed response is intentionally bounded: do not expose SQL/provider/credential details.
      console.error(`[admin-sync] webhook status unavailable: ${error?.message || 'unknown error'}`);
      return res.status(503).json({ ok: false, service: 'ok', database: 'unavailable', error: 'Status temporarily unavailable' });
    }
  }
  const result = await appWithDb(db => enqueueJob(db, {
    action,
    idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey,
    requestedBy: 'apps-script-webhook'
  }));
  jobWorker.kick();
  res.status(result.duplicate ? 200 : 202).json({ ok: true, duplicate: result.duplicate, job: result.job });
}));
app.use(authMiddleware);
app.use('/report', createReportRouter({ customers: reportCustomers, withDb: appWithDb, publicDir }));
app.use('/api/report', createReportApiRouter({ customers: reportCustomers, withDb: appWithDb }));
app.use(express.static(publicDir));

app.use('/api', (req, res, next) => validRange(req.query) ? next() : res.status(400).json({ ok: false, error: 'Invalid date range' }));

app.get('/api/status', asyncRoute(async (req, res) => {
  const data = await appWithDb(async db => (await db.query(`select now() as now,
    (select max(finished_at) from sync_runs where status in ('ok','partial')) as "lastSyncAt",
    (select max(updated_at) from posts_raw_sheet) as "mirrorUpdatedAt"`)).rows[0]);
  res.json({ ok: true, ...data, service: 'onicorn-dashboard-system' });
}));
app.get('/api/overview', asyncRoute(async (req, res) => res.json(await appWithDb(db => getOverview(db, req.query)))));
app.get('/api/brands', asyncRoute(async (req, res) => res.json(await appWithDb(db => getTopBrands(db, asInt(req.query.limit, 50), req.query)))));
app.get('/api/staff', asyncRoute(async (req, res) => res.json(await appWithDb(db => getTopStaff(db, asInt(req.query.limit, 50), req.query)))));
app.get('/api/channels', asyncRoute(async (req, res) => res.json(await appWithDb(db => getTopChannels(db, asInt(req.query.limit, 50), req.query)))));
app.get('/api/posts', asyncRoute(async (req, res) => res.json(await appWithDb(db => getPosts(db, req.query)))));

app.get('/api/timeseries', asyncRoute(async (req, res) => res.json(await appWithDb(db => getTimeseries(db, req.query)))));
app.get('/api/issues', asyncRoute(async (req, res) => res.json(await appWithDb(db => getIssues(db, req.query)))));
app.get('/api/issue-types', asyncRoute(async (req, res) => res.json(await appWithDb(getIssueTypes))));
app.get('/api/masters', asyncRoute(async (req, res) => res.json(await appWithDb(getMasters))));
app.get('/api/alerts', asyncRoute(async (req, res) => res.json(await appWithDb(getAlerts))));
app.get('/api/heatmap', asyncRoute(async (req, res) => res.json(await appWithDb(db => getHeatmap(db, req.query)))));
app.get('/api/admin/report-links', asyncRoute(async (req, res) => {
  const key = registryKey();
  const { clients, brands } = await appWithDb(async db => ({
    clients: (await db.query(`select c.client_code,c.name,c.active,r.status,r.token_ciphertext,r.token_iv,r.token_tag,r.created_at,r.rotated_at
      from clients c left join report_link_registry r on r.scope='customer' and r.object_code=c.client_code
      order by c.active desc,c.name,c.client_code`)).rows,
    brands: (await db.query(`select b.brand_code,b.name,b.client_code,b.client_name,b.active,
      count(*) filter (where b.active) over (partition by lower(regexp_replace(trim(b.name), '\\s+', ' ', 'g')))::int as canonical_count,
      r.status,r.token_ciphertext,r.token_iv,r.token_tag,r.created_at,r.rotated_at
      from brands b left join report_link_registry r on r.scope='brand' and r.object_code=b.brand_code
      where b.brand_code is not null order by b.active desc,b.name,b.brand_code`)).rows
  }));
  const configuredCustomers = new Set(reportCustomers.filter(item => item.scope !== 'brand').map(item => item.clientCode));
  const configuredBrands = new Set(reportCustomers.filter(item => item.scope === 'brand').map(item => item.brandCode));
  const reportPath = row => {
    if (!row.active || row.status !== 'active') return null;
    try { const token = decryptReportToken(row, key); return token ? `/report/${token}` : null; } catch { return null; }
  };
  res.json({
    clients: clients.map(item => ({ ...item, configured: item.status === 'active' || configuredCustomers.has(item.client_code), reportPath: reportPath(item), linkState: !item.active ? 'inactive' : item.status === 'revoked' ? 'revoked' : item.status === 'active' ? (reportPath(item) ? 'ready' : 'hash-only') : 'missing', token_ciphertext: undefined, token_iv: undefined, token_tag: undefined })),
    brands: brands.map(item => {
      const ambiguous = item.canonical_count !== 1;
      return { ...item, ambiguous, configured: !ambiguous && (item.status === 'active' || configuredBrands.has(item.brand_code)), reportPath: !ambiguous ? reportPath(item) : null, linkState: !item.active ? 'inactive' : ambiguous ? 'ambiguous' : item.status === 'revoked' ? 'revoked' : item.status === 'active' ? (reportPath(item) ? 'ready' : 'hash-only') : 'missing', token_ciphertext: undefined, token_iv: undefined, token_tag: undefined };
    }),
    operations: { import: 'npm run portal:import-config -- --apply <config>', importLegacy: 'npm run portal:import-legacy-links -- --apply <export>', ensure: 'npm run portal:ensure-active -- --apply' }
  });
}));
app.get('/api/admin/sync/status', asyncRoute(async (req, res) => {
  try {
    res.json({ ok: true, ...(await appWithDb(db => syncStatus(db))) });
  } catch (error) {
    // Keep the admin UI actionable when the control-plane migration is absent or DB is unavailable.
    // Never expose SQL, connection strings, or provider details to the browser.
    const message = String(error?.message || '').toLowerCase();
    const migrationMissing = message.includes('admin_sync_jobs') || message.includes('nv_ingestion_checkpoints');
    console.error(`[admin-sync] status unavailable: ${error?.message || 'unknown error'}`);
    res.status(503).json({ ok: false, error: migrationMissing ? 'Admin sync database migration is not installed' : 'Admin sync status temporarily unavailable', code: migrationMissing ? 'ADMIN_SYNC_MIGRATION_REQUIRED' : 'ADMIN_SYNC_STATUS_UNAVAILABLE' });
  }
}));
app.post('/api/admin/sync/actions', asyncRoute(async (req, res) => {
  const result = await appWithDb(db => enqueueJob(db, {
    action: req.body?.action,
    idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey,
    requestedBy: 'dashboard-session'
  }));
  jobWorker.kick();
  res.status(result.duplicate ? 200 : 202).json({ ok: true, duplicate: result.duplicate, job: result.job });
}));
app.post('/api/admin/sync/jobs/:id/retry', asyncRoute(async (req, res) => {
  const result = await appWithDb(db => retryJob(db, req.params.id, 'dashboard-session'));
  jobWorker.kick();
  res.status(result.duplicate ? 200 : 202).json({ ok: true, duplicate: result.duplicate, job: result.job });
}));

app.get('/api/health', asyncRoute(async (req, res) => res.json(await appWithDb(db => getHealth(db, asInt(req.query.limit, 100))))));
app.get('/api/dashboard', asyncRoute(async (req, res) => {
  const started = Date.now();
  try {
    // Keep one connection for the request, but issue independent read-only queries together.
    // pg queues these safely on the same client and avoids repeated connection setup.
    const data = await appWithDb(async db => {
      const [overview, brands, staff, channels, health, timeseries, alerts, masters, heatmap] = await Promise.all([
        getOverview(db, req.query), getTopBrands(db, 20, req.query), getTopStaff(db, 20, req.query),
        getTopChannels(db, 20, req.query), getHealth(db, 20), getTimeseries(db, req.query),
        getAlerts(db), getMasters(db), getHeatmap(db, req.query)
      ]);
      return { overview, brands, staff, channels, health, timeseries, alerts, masters, heatmap };
    });
    const elapsedMs = Date.now() - started;
    // Bounded diagnostics only: no query text, credentials, or payload data.
    if (elapsedMs > 2000) console.warn(`[dashboard] completed in ${elapsedMs}ms`);
    res.set('Server-Timing', `dashboard;dur=${elapsedMs}`);
    res.json(data);
  } catch (error) {
    const elapsedMs = Date.now() - started;
    console.error(`[dashboard] failed after ${elapsedMs}ms: ${error?.message || 'unknown error'}`);
    throw error;
  }
}));

app.use((err, req, res, next) => {
  console.error('Request failed:', err?.message || 'Unknown error');
  res.status(err.statusCode || 500).json({ ok: false, error: err.statusCode ? err.message : 'Internal server error' });
});

return app;
}

export const app = createApp();
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(port, () => { console.log(`Onicorn Dashboard API listening on http://localhost:${port}`); app.locals.jobWorker.kick(); });
}
