/**
 * Main API router.
 * Mounts sub-routers under /api (prefix already stripped by server.js).
 */
'use strict';

const express         = require('express');
const accountsRouter  = require('./routes/accounts');

const router = express.Router();

router.use('/accounts', accountsRouter);

// Health check
router.get('/health', function (req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = router;
