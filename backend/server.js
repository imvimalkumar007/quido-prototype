/**
 * Quido Backend — server entry point
 *
 * Starts the Express API on PORT (default 3001).
 * Serves the shared engine files statically so frontends can load them
 * directly from the backend during development.
 *
 * Run:  node server.js
 */
'use strict';

const express    = require('express');
const path       = require('path');
const corsMiddleware  = require('./api/middleware/cors-and-json');
const errorHandler   = require('./api/middleware/error-handler');
const apiRouter      = require('./api/router');
const { FileDomainStore } = require('./repositories/file-domain-store');
const AccountService = require('./services/account-service');

const PORT   = process.env.PORT   || 3001;
const DB_DIR = process.env.DB_DIR || path.join(__dirname, 'db', 'accounts');

// ── Bootstrap dependencies ──────────────────────────────────────────────────
// FileDomainStore implements all domain repository interfaces over JSON files.
// To switch to a real database, replace FileDomainStore with a database-backed
// store (e.g. PostgresDomainStore) that exposes the same method surface.
const store          = new FileDomainStore(DB_DIR);
const accountService = new AccountService(store);

// ── Express setup ───────────────────────────────────────────────────────────
const app = express();
const ROOT_DIR = path.join(__dirname, '..');
const CUSTOMER_PORTAL = path.join(ROOT_DIR, 'quido_loans.html');
const OPS_PORTAL = path.join(ROOT_DIR, 'quido_ops.html');

app.use(corsMiddleware);
app.use(express.json({ limit: '4mb' }));

// Static assets and shared browser-side code
app.use('/shared', express.static(path.join(ROOT_DIR, 'shared')));
app.use('/backend', express.static(path.join(ROOT_DIR, 'backend')));

// API routes — inject service via app.locals
app.locals.accountService = accountService;
app.use('/api', apiRouter);

// Public prototype routes
app.get('/', function (req, res) {
  res.sendFile(CUSTOMER_PORTAL);
});

app.get('/customer', function (req, res) {
  res.sendFile(CUSTOMER_PORTAL);
});

app.get('/ops', function (req, res) {
  res.sendFile(OPS_PORTAL);
});

app.get('/ops-ui', function (req, res) {
  res.redirect(302, '/ops');
});

// Error handler (must be last)
app.use(errorHandler);

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, function () {
  console.log('');
  console.log('  Quido backend — Flexibility when it matters most');
  console.log('  API root         →  http://localhost:' + PORT + '/api');
  console.log('  DB directory     →  ' + DB_DIR);
  console.log('');
});
