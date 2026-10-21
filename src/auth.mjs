import crypto from 'node:crypto';

const COOKIE = 'dalat_time_session';
const base64url = value => Buffer.from(value).toString('base64url');
const secret = () => process.env.AUTH_SESSION_SECRET || '';
function signature(payload) { return base64url(crypto.createHmac('sha256', secret()).update(payload).digest()); }
function sessionPayload(value) {
  if (!secret() || !value) return null;
  const [payload, sig] = value.split('.');
  if (!payload || !sig) return null;
  const expected = signature(payload);
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url'));
    return parsed.exp > Date.now() ? parsed : null;
  } catch { return null; }
}
export function createSessionCookie(maxAge = 8 * 60 * 60 * 1000, username = 'dashboard-user') {
  const payload = base64url(JSON.stringify({ exp: Date.now() + maxAge, sub: String(username || 'dashboard-user').slice(0,128) }));
  return `${COOKIE}=${payload}.${signature(payload)}; Max-Age=${Math.floor(maxAge / 1000)}; Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}
export function clearSessionCookie() { return `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`; }
export function credentialsMatch(username, password) {
  return Boolean(process.env.DASHBOARD_BASIC_USER && process.env.DASHBOARD_BASIC_PASS && username === process.env.DASHBOARD_BASIC_USER && password === process.env.DASHBOARD_BASIC_PASS);
}
export function authMiddleware(req, res, next) {
  if (req.path === '/login' || req.path === '/login.css' || req.path === '/login.js' || req.path.startsWith('/report/') || req.path.startsWith('/api/report/')) return next();
  if (req.path === '/login' || req.path === '/auth/login' || req.path === '/auth/logout') return next();
  if (req.path === '/api/status') return next();
  if (process.env.NODE_ENV !== 'production' && !process.env.DASHBOARD_AUTH_TOKEN && !process.env.DASHBOARD_BASIC_USER) return next();
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(v => { const i = v.indexOf('='); return [v.slice(0, i).trim(), v.slice(i + 1)]; }));
  const session = sessionPayload(cookies[COOKIE]);
  if (session) { req.auth = { user: session.sub || 'dashboard-user', mechanism: 'session' }; return next(); }
  const bearer = process.env.DASHBOARD_AUTH_TOKEN;
  if (bearer && req.headers.authorization === `Bearer ${bearer}`) { req.auth = { user: 'service-token', mechanism: 'bearer' }; return next(); }
  const user = process.env.DASHBOARD_BASIC_USER, pass = process.env.DASHBOARD_BASIC_PASS;
  if (user && pass && (req.headers.authorization || '').startsWith('Basic ')) {
    const raw = Buffer.from(req.headers.authorization.slice(6), 'base64').toString('utf8');
    if (raw === `${user}:${pass}`) { req.auth = { user, mechanism: 'basic' }; return next(); }
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  return res.redirect('/login');
}
