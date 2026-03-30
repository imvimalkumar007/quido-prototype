/**
 * Centralised Express error handler.
 * Must be registered as the last middleware.
 */
'use strict';

// eslint-disable-next-line no-unused-vars
module.exports = function errorHandler(err, req, res, next) {
  const status  = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';

  if (status >= 500) {
    console.error('[Quido API error]', err);
  }

  res.status(status).json({ error: message });
};
