'use strict';

const express = require('express');
const { lookupPostcode } = require('../../services/postcode-service');
const { getDisbursalCalendar } = require('../../services/bank-holiday-service');

const router = express.Router();

function svc(req) {
  return req.app.locals.accountService;
}

router.post('/profiles', function (req, res, next) {
  try {
    res.json(svc(req).createPublicProfile(req.body || {}));
  } catch (err) {
    next(err);
  }
});

router.post('/quote', function (req, res, next) {
  try {
    res.json({ decision: svc(req).calculatePublicQuote(req.body || {}) });
  } catch (err) {
    next(err);
  }
});

router.post('/contact', function (req, res, next) {
  try {
    res.json(svc(req).submitContactMessage(null, req.body || {}, 'public_site'));
  } catch (err) {
    next(err);
  }
});

router.get('/postcodes/:postcode', async function (req, res, next) {
  try {
    res.json(await lookupPostcode(req.params.postcode));
  } catch (err) {
    next(err);
  }
});

router.get('/disbursal-calendar', async function (req, res, next) {
  try {
    res.json(await getDisbursalCalendar({
      date: req.query.date || '',
      division: req.query.division || 'england-and-wales',
      allowSameDay: req.query.sameDay !== 'false'
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/auth/login', function (req, res, next) {
  try {
    var body = req.body || {};
    var account = svc(req).findByAuth(body.email, body.pin);
    if (!account) return res.status(401).json({ error: 'Invalid email or PIN.' });
    res.json({ account: account, resolved: svc(req).resolveAccount(account.storageKey) });
  } catch (err) {
    next(err);
  }
});

router.post('/applications', function (req, res, next) {
  try {
    var body = req.body || {};
    if (!body.storageKey) return res.status(400).json({ error: 'storageKey is required.' });
    res.json(svc(req).submitApplication(body.storageKey, body));
  } catch (err) {
    next(err);
  }
});

router.get('/applications', function (req, res, next) {
  try {
    var apps = svc(req).listApplications(req.query.stage || '');
    var summaries = apps.map(function (account) {
      return {
        storageKey: account.storageKey,
        customerId: account.customerId,
        name: [account.profile.personal.firstName, account.profile.personal.lastName].filter(Boolean).join(' '),
        email: account.auth.email || account.profile.contact.email || '',
        stage: account.application.stage,
        quote: account.application.quote,
        submittedAt: account.application.submittedAt,
        signedAt: account.application.signedAt,
        decision: account.application.decision
      };
    });
    res.json({ applications: summaries });
  } catch (err) {
    next(err);
  }
});

router.get('/applications/:key', function (req, res, next) {
  try {
    var account = svc(req).getAccount(req.params.key);
    if (!account) return res.status(404).json({ error: 'Account not found.' });
    res.json({ account: account, resolved: svc(req).resolveAccount(req.params.key) });
  } catch (err) {
    next(err);
  }
});

router.post('/applications/:key/sign', function (req, res, next) {
  try {
    res.json(svc(req).signApplication(req.params.key, req.body || {}));
  } catch (err) {
    next(err);
  }
});

router.post('/applications/:key/card', function (req, res, next) {
  try {
    res.json(svc(req).saveCardDetails(req.params.key, req.body || {}));
  } catch (err) { next(err); }
});

router.post('/applications/:key/disbursal/approve', function (req, res, next) {
  try {
    res.json(svc(req).approveDisbursal(req.params.key, (req.body && req.body.actor) || 'ops_ui'));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
