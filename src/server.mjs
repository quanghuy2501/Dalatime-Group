import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { connectDb } from './db/postgres.mjs';
import { authMiddleware } from './auth.mjs';
import { getOverview, getTopBrands, getTopStaff, getTopChannels, getPosts, getHealth, getTimeseries, getIssues, getIssueTypes, getMasters, getAlerts, getHeatmap } from './db/queries.mjs';
import { loadReportCustomers } from './report/config.mjs';
import { createReportApiRouter, createReportRouter } from './report/routes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4177);
const publicDir = path.join(__dirname, '..', 'public');
const reportLinksPath = process.env.REPORT_PORTAL_LINKS_FILE || 'config/report-links.local.json';
function loadReportLinks() {
  try {
    const raw = fs.readFileSync(path.resolve(process.cwd(), reportLinksPath), 'utf8');
    const parsed = JSON.parse(raw);
    return new Map((parsed.customers || parsed.oneTime || []).map(item => [item.clientCode, item.reportPath]));
  } catch { return new Map(); }
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
function asInt(v, fallback) { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : fallback; }
function validRange(query) {
  const date = v => !v || /^\d{4}-\d{2}-\d{2}$/.test(String(v));
  return date(query.from) && date(query.to) && !(query.from && query.to && query.from > query.to);
}

export function createApp({ dbConnector = connectDb, reportCustomers } = {}) {
const app = express();
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
app.use(express.json());
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
  const clients = await appWithDb(async db => (await db.query('select client_code,name,active from clients order by active desc,name')).rows);
  const configured = new Set(reportCustomers.map(item => item.clientCode));
  const reportLinks = loadReportLinks();
  res.json({ clients: clients.map(item => ({ ...item, configured: configured.has(item.client_code), reportPath: reportLinks.get(item.client_code) || null })), operation: 'npm run portal:token -- <CLIENT_CODE>' });
}));

app.get('/api/health', asyncRoute(async (req, res) => res.json(await appWithDb(db => getHealth(db, asInt(req.query.limit, 100))))));
app.get('/api/dashboard', asyncRoute(async (req, res) => {
  const data = await appWithDb(async db => ({
    overview: await getOverview(db, req.query),
    brands: await getTopBrands(db, 20, req.query),
    staff: await getTopStaff(db, 20, req.query),
    channels: await getTopChannels(db, 20, req.query),
    health: await getHealth(db, 20),
    timeseries: await getTimeseries(db, req.query),
    alerts: await getAlerts(db),
    masters: await getMasters(db),
    heatmap: await getHeatmap(db, req.query)
  }));
  res.json(data);
}));

app.use((err, req, res, next) => {
  console.error('Request failed:', err?.message || 'Unknown error');
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

return app;
}

export const app = createApp();
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(port, () => console.log(`Onicorn Dashboard API listening on http://localhost:${port}`));
}
