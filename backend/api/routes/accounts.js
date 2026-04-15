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
    var summaries = svc(req).listAccountSummaries();
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

router.post('/:key/contact', function (req, res, next) {
  try {
    res.json(svc(req).submitContactMessage(req.params.key, req.body || {}, 'customer_ui'));
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

module.exports = router;
