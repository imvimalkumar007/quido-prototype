/**
 * /api/accounts - REST route handlers
 */
'use strict';

const express = require('express');
const documentService = require('../../services/document-service');

const router = express.Router();

function svc(req) {
  return req.app.locals.accountService;
}

router.get('/', function (req, res, next) {
  try {
    var accounts = svc(req).listAccounts().filter(function (a) {
      return !!(a.activeLoanId || (a.loans && a.loans.length));
    });
    var summaries = accounts.map(function (a) {
      var loan = getActiveLoanFromAccount(a);
      var lc = (loan && loan.loanCore) || {};
      var se = (loan && loan.statusEngineState) || {};
      var pp = (a.profile && a.profile.personal) || {};
      var pc = (a.profile && a.profile.contact) || {};
      return {
        storageKey: a.storageKey,
        customerId: a.customerId,
        version: a.version || 0,
        updatedAt: a.updatedAt || '',
        name: [pp.firstName, pp.lastName].filter(Boolean).join(' '),
        initials: pp.initials || '',
        email: pc.email || '',
        phone: pc.phone || '',
        dob: pp.dob || '',
        address: pc.address || '',
        loanId: a.activeLoanId || '',
        loanStatus: se.displayStatus || se.coreStatus || 'active',
        applicationStage: (a.application && a.application.stage) || '',
        outstanding: (loan && loan.loanSummary && loan.loanSummary.outstandingBalance) || lc.principal || 0,
        originatedAt: (loan && loan.originatedAt) || ''
      };
    });
    res.json({ accounts: summaries });
  } catch (err) {
    next(err);
  }
});

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

router.post('/sync', function (req, res, next) {
  try {
    var body = req.body || {};
    var storageKey = body.storageKey;
    var clientAccount = body.account || null;
    var seed = body.seed || null;

    if (!storageKey) {
      return res.status(400).json({ error: 'storageKey is required' });
    }

    var result = svc(req).syncAccount(storageKey, clientAccount, seed);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

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

router.get('/:key/documents', function (req, res, next) {
  try {
    var scope = req.query.scope === 'ops' ? 'ops' : 'customer';
    var resolved = svc(req).resolveAccount(req.params.key);
    if (!resolved) {
      return res.status(404).json({ error: 'Account not found: ' + req.params.key });
    }
    var documents = documentService.buildDocumentCatalog(resolved, scope).map(function (doc) {
      return {
        type: doc.type,
        title: doc.title,
        subtitle: doc.subtitle,
        category: doc.category,
        available: doc.available,
        documentId: doc.documentId,
        fileName: doc.fileName
      };
    });
    res.json({ documents: documents });
  } catch (err) {
    next(err);
  }
});

router.get('/:key/documents/:type/pdf', function (req, res, next) {
  try {
    var scope = req.query.scope === 'ops' ? 'ops' : 'customer';
    var resolved = svc(req).resolveAccount(req.params.key);
    if (!resolved) {
      return res.status(404).json({ error: 'Account not found: ' + req.params.key });
    }
    var catalog = documentService.buildDocumentCatalog(resolved, scope);
    var doc = documentService.getDocument(catalog, req.params.type);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found: ' + req.params.type });
    }
    var pdf = documentService.buildSimplePdfBuffer(doc.title, doc.html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + doc.fileName + '"');
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

router.get('/:key/documents/:type', function (req, res, next) {
  try {
    var scope = req.query.scope === 'ops' ? 'ops' : 'customer';
    var resolved = svc(req).resolveAccount(req.params.key);
    if (!resolved) {
      return res.status(404).json({ error: 'Account not found: ' + req.params.key });
    }
    var catalog = documentService.buildDocumentCatalog(resolved, scope);
    var doc = documentService.getDocument(catalog, req.params.type);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found: ' + req.params.type });
    }
    res.json({ document: doc });
  } catch (err) {
    next(err);
  }
});

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

function getActiveLoanFromAccount(account) {
  var loans = account.loans || [];
  for (var i = 0; i < loans.length; i++) {
    if (loans[i].loanId === account.activeLoanId) return loans[i];
  }
  return loans[0] || null;
}

module.exports = router;
