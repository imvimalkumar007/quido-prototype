/**
 * /api/accounts — REST route handlers
 *
 * Routes:
 *   GET  /api/accounts              — list all accounts (ops directory)
 *   GET  /api/accounts/:key         — get one account by storageKey
 *   POST /api/accounts/sync         — upsert / reconcile client state
 *   POST /api/accounts/:key/commands — dispatch a command (mutation)
 *
 * All handlers delegate business logic to AccountService via app.locals.
 */
'use strict';

const express = require('express');
const router  = express.Router();

// ── Helper: get service from app.locals ───────────────────────────────────

function svc(req) {
  return req.app.locals.accountService;
}

// ── GET /api/accounts ─────────────────────────────────────────────────────

/**
 * List all accounts.
 * Used by the ops directory to populate the customer list.
 * Returns a summary projection, not full account bodies.
 */
router.get('/', function (req, res, next) {
  try {
    var accounts = svc(req).listAccounts();

    // Project to a lightweight summary for the directory listing
    var summaries = accounts.map(function (a) {
      var loan       = getActiveLoanFromAccount(a);
      var lc         = (loan && loan.loanCore)          || {};
      var se         = (loan && loan.statusEngineState)  || {};
      var pp         = (a.profile && a.profile.personal) || {};
      var pc         = (a.profile && a.profile.contact)  || {};
      return {
        storageKey:    a.storageKey,
        customerId:    a.customerId,
        version:       a.version     || 0,
        updatedAt:     a.updatedAt   || '',
        name:          [pp.firstName, pp.lastName].filter(Boolean).join(' '),
        initials:      pp.initials   || '',
        email:         pc.email      || '',
        loanId:        a.activeLoanId || '',
        loanStatus:    se.displayStatus || se.coreStatus || 'active',
        outstanding:   (loan && loan.loanSummary && loan.loanSummary.outstandingBalance) || lc.principal || 0,
        originatedAt:  (loan && loan.originatedAt) || ''
      };
    });

    res.json({ accounts: summaries });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/accounts/:key ────────────────────────────────────────────────

/**
 * Return the full v3 account for a given storageKey.
 * Returns 404 if the account does not exist.
 */
router.get('/:key', function (req, res, next) {
  try {
    var account = svc(req).getAccount(req.params.key);
    if (!account) {
      return res.status(404).json({ error: 'Account not found: ' + req.params.key });
    }
    res.json({ account: account });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/accounts/sync ───────────────────────────────────────────────

/**
 * Sync / upsert an account from client state.
 *
 * Body: { storageKey, account?, seed? }
 *
 * The backend reconciles versions:
 *  - If backend has no record → saves client account (or creates from seed)
 *  - If backend version > client version → returns backend account (client is stale)
 *  - If client version >= backend version → accepts client, saves to backend
 *
 * Response always includes:
 *   { account, source: 'backend'|'client'|'seed' }
 */
router.post('/sync', function (req, res, next) {
  try {
    var body          = req.body || {};
    var storageKey    = body.storageKey;
    var clientAccount = body.account || null;
    var seed          = body.seed    || null;

    if (!storageKey) {
      return res.status(400).json({ error: 'storageKey is required' });
    }

    var result = svc(req).syncAccount(storageKey, clientAccount, seed);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/accounts/:key/resolved ──────────────────────────────────────

/**
 * Return the pre-computed resolved account view.
 *
 * The resolved view is a flat, UI-ready projection of the canonical v3
 * account.  Both frontends consume this directly without any client-side
 * selector logic, active-loan resolution, or schedule conversion.
 *
 * Shape:
 *   { storageKey, customerId, version, updatedAt,
 *     profile, contact, employment, paymentDetails, affordability,
 *     activeLoan: { core, emi, summary, status, schedule, transactions,
 *                   arrangements },
 *     loanHistory, ops }
 *
 * Returns 404 if the account does not exist.
 */
router.get('/:key/resolved', function (req, res, next) {
  try {
    var resolved = svc(req).resolveAccount(req.params.key);
    if (!resolved) {
      return res.status(404).json({ error: 'Account not found: ' + req.params.key });
    }
    res.json({ resolved: resolved });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/accounts/:key/commands ─────────────────────────────────────

/**
 * Dispatch a command (mutation) on an account.
 *
 * Body: { type, payload, actor }
 *   type   — one of the CommandTypes constants (e.g. 'RECORD_PAYMENT')
 *   payload — command-specific data
 *   actor  — 'customer_ui' | 'ops_ui' | 'system'
 *
 * Returns the full updated account.
 * Returns 404 if the account does not exist.
 */
router.post('/:key/commands', function (req, res, next) {
  try {
    var command = req.body || {};

    if (!command.type) {
      return res.status(400).json({ error: 'command.type is required' });
    }

    var result = svc(req).applyCommand(req.params.key, command);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Internal helper ───────────────────────────────────────────────────────

function getActiveLoanFromAccount(account) {
  var loans = account.loans || [];
  for (var i = 0; i < loans.length; i++) {
    if (loans[i].loanId === account.activeLoanId) return loans[i];
  }
  return loans[0] || null;
}

module.exports = router;
