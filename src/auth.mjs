import crypto from 'node:crypto';

const COOKIE = 'dalat_time_session';
const base64url = value => Buffer.from(value).toString('base64url');
const secret = () => process.env.AUTH_SESSION_SECRET || '';
function signature(payload) { return base64url(crypto.createHmac('sha256', secret()).update(payload).digest()); }
function validCookie(value) {
  if (!secret() || !value) return false;
  const [payload, sig] = value.split('.');
  if (!payload || !sig) return false;
  const expected = signature(payload);
  if (sig.length !== expected.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) && JSON.parse(Buffer.from(payload, 'base64url')).exp > Date.now(); } catch { return false; }
}
export function createSessionCookie(maxAge = 8 * 60 * 60 * 1000) {
  const payload = base64url(JSON.stringify({ exp: Date.now() + maxAge }));
  return `${COOKIE}=${payload}.${signature(payload)}; Max-Age=${Math.floor(maxAge / 1000)}; Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}
export function clearSessionCookie() { return `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`; }
export function credentialsMatch(username, password) {
  return Boolean(process.env.DASHBOARD_BASIC_USER && process.env.DASHBOARD_BASIC_PASS && username === process.env.DASHBOARD_BASIC_USER && password === process.env.DASHBOARD_BASIC_PASS);
}
export function authMiddleware(req, res, next) {
  if (req.path.startsWith('/report/') || req.path.startsWith('/api/report/')) return next();
  if (req.path === '/login' || req.path === '/auth/login' || req.path === '/auth/logout') return next();
  if (req.path === '/api/status') return next();
  if (process.env.NODE_ENV !== 'production' && !process.env.DASHBOARD_AUTH_TOKEN && !process.env.DASHBOARD_BASIC_USER) return next();
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(v => { const i = v.indexOf('='); return [v.slice(0, i).trim(), v.slice(i + 1)]; }));
  if (validCookie(cookies[COOKIE])) return next();
  const bearer = process.env.DASHBOARD_AUTH_TOKEN;
  if (bearer && req.headers.authorization === `Bearer ${bearer}`) return next();
  const user = process.env.DASHBOARD_BASIC_USER, pass = process.env.DASHBOARD_BASIC_PASS;
  if (user && pass && (req.headers.authorization || '').startsWith('Basic ')) {
    const raw = Buffer.from(req.headers.authorization.slice(6), 'base64').toString('utf8');
    if (raw === `${user}:${pass}`) return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  return res.redirect('/login');
}
