import express from 'express';
import path from 'path';
import { resolveReportCustomer } from './config.mjs';
import { getReportOverview, getReportPosts, getReportScope, getReportStatus, getReportTimeseries } from './queries.mjs';

function validDate(value) { return !value || /^\d{4}-\d{2}-\d{2}$/.test(value); }

export function createReportRouter({ customers, withDb, publicDir }) {
  const router = express.Router({ mergeParams: true });
  router.use('/:token', (req, res, next) => {
    const customer = resolveReportCustomer(req.params.token, customers);
    if (!customer) return res.status(404).send('Not found');
    req.reportCustomer = customer;
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
      const customer = resolveReportCustomer(req.params.token, customers);
      if (!customer) return res.status(404).json({ ok: false, error: 'Not found' });
      if (!validDate(req.query.from) || !validDate(req.query.to) || (req.query.from && req.query.to && req.query.from > req.query.to)) {
        return res.status(400).json({ ok: false, error: 'Invalid date range' });
      }
      const scope = await withDb(db => getReportScope(db, customer.clientCode));
      if (!scope) return res.status(404).json({ ok: false, error: 'Not found' });
      if (req.query.brand && !scope.brands.includes(req.query.brand)) return res.status(400).json({ ok: false, error: 'Invalid brand filter' });
      if (req.query.channel && !scope.channels.includes(req.query.channel)) return res.status(400).json({ ok: false, error: 'Invalid channel filter' });
      req.reportCustomer = customer;
      req.reportScope = scope;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      next();
    } catch (error) { next(error); }
  });
  router.get('/:token/status', (req, res, next) => withDb(db => getReportStatus(db, req.reportCustomer.clientCode, req.reportScope)).then(data => res.json(data), next));
  router.get('/:token/overview', (req, res, next) => withDb(db => getReportOverview(db, req.reportCustomer.clientCode, req.query)).then(data => res.json(data), next));
  router.get('/:token/timeseries', (req, res, next) => withDb(db => getReportTimeseries(db, req.reportCustomer.clientCode, req.query)).then(data => res.json(data), next));
  router.get('/:token/posts', (req, res, next) => withDb(db => getReportPosts(db, req.reportCustomer.clientCode, req.query)).then(data => res.json(data), next));
  return router;
}
