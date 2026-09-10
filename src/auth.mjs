export function authMiddleware(req, res, next) {
  if (req.path.startsWith('/report/') || req.path.startsWith('/api/report/')) return next();
  if (process.env.NODE_ENV !== 'production' && !process.env.DASHBOARD_AUTH_TOKEN && !process.env.DASHBOARD_BASIC_USER) return next();
  if (req.path === '/api/status') return next();
  const bearer = process.env.DASHBOARD_AUTH_TOKEN;
  if (bearer) {
    const h = req.headers.authorization || '';
    if (h === `Bearer ${bearer}`) return next();
  }
  const user = process.env.DASHBOARD_BASIC_USER;
  const pass = process.env.DASHBOARD_BASIC_PASS;
  if (user && pass) {
    const h = req.headers.authorization || '';
    if (h.startsWith('Basic ')) {
      const raw = Buffer.from(h.slice(6), 'base64').toString('utf8');
      if (raw === `${user}:${pass}`) return next();
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="Onicorn Dashboard"');
  }
  res.status(401).send('Unauthorized');
}
