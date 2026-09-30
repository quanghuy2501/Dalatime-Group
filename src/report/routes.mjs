import express from 'express';
import path from 'path';
import { resolveReportPrincipal } from './config.mjs';
import { getBrandReportOverview, getBrandReportPosts, getBrandReportScope, getBrandReportStatus, getBrandReportTimeseries, getReportOverview, getReportPosts, getReportScope, getReportStatus, getReportTimeseries } from './queries.mjs';

function validDate(value) { return !value || /^\d{4}-\d{2}-\d{2}$/.test(value); }

export function createReportRouter({ customers, withDb, publicDir }) {
  const router = express.Router({ mergeParams: true });
  router.use('/:token', (req, res, next) => {
    const principal = resolveReportPrincipal(req.params.token, customers);
    if (!principal) return res.status(404).send('Not found');
    req.reportPrincipal = principal;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  router.get('/:token', (req, res) => res.sendFile(path.join(publicDir, 'report.html')));
  return router;
}

export function createReportApiRouter({ customers, withDb }) {
  const router = express.Router({ mergeParams: true });
  router.use('/:token', async (req, res, next) => {
    try {
      const principal = resolveReportPrincipal(req.params.token, customers);
      if (!principal) return res.status(404).json({ ok: false, error: 'Not found' });
      if (!validDate(req.query.from) || !validDate(req.query.to) || (req.query.from && req.query.to && req.query.from > req.query.to)) {
        return res.status(400).json({ ok: false, error: 'Invalid date range' });
      }
      const isBrand = principal.scope === 'brand';
      const scope = await withDb(db => isBrand ? getBrandReportScope(db, principal.brandCode) : getReportScope(db, principal.clientCode));
      if (!scope) return res.status(404).json({ ok: false, error: 'Not found' });
      if (isBrand && req.query.brand) return res.status(400).json({ ok: false, error: 'Invalid brand filter' });
      if (!isBrand && req.query.brand && !scope.brands.includes(req.query.brand)) return res.status(400).json({ ok: false, error: 'Invalid brand filter' });
      if (req.query.channel && !scope.channels.includes(req.query.channel)) return res.status(400).json({ ok: false, error: 'Invalid channel filter' });
      req.reportPrincipal = principal;
      req.reportScope = scope;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      next();
    } catch (error) { next(error); }
  });
  const run = (customerFn, brandFn) => (req, res, next) => withDb(db => req.reportPrincipal.scope === 'brand'
    ? brandFn(db, req.reportScope, req.query)
    : customerFn(db, req.reportPrincipal.clientCode, req.query, req.reportScope)).then(data => res.json(data), next);
  router.get('/:token/status', run((db, clientCode, _query, scope) => getReportStatus(db, clientCode, scope), (db, scope) => getBrandReportStatus(db, scope)));
  router.get('/:token/overview', run(getReportOverview, getBrandReportOverview));
  router.get('/:token/timeseries', run(getReportTimeseries, getBrandReportTimeseries));
  router.get('/:token/posts', run(getReportPosts, getBrandReportPosts));
  return router;
}
