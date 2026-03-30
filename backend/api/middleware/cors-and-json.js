/**
 * CORS middleware.
 *
 * Allows requests from:
 *  - file:// pages (browser sends origin: null)
 *  - localhost on any port (development frontends)
 *  - any configured ALLOWED_ORIGIN env var
 */
'use strict';

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null;

module.exports = function corsMiddleware(req, res, next) {
  const origin = req.headers.origin || '';

  // file:// pages send a null origin — allow them unconditionally in dev
  const isNull      = origin === 'null';
  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const isAllowed   = ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN;

  if (isNull || isLocalhost || isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', isNull ? 'null' : origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    // Fallback: permissive in dev, tighten for production
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Actor');

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
};
