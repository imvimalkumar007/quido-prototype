/**
 * AccountService — application service layer
 *
 * Owns all business-level operations on customerAccount objects:
 *   - Retrieving accounts (aggregate and domain-specific)
 *   - Creating accounts from seed data
 *   - Reconciling client state with backend state (sync)
 *   - Applying commands (mutations)
 *
 * This layer sits between the HTTP route handlers and the domain store.
 * It does NOT know about HTTP (req/res). It works with plain JS objects.
 *
 * Dependency: a domain store that implements all repository interfaces
 *   (AccountRepository, CustomerRepository, LoanRepository,
 *    AffordabilityRepository, PaymentDetailsRepository,
 *    TransactionRepository, ScheduleRepository).
 *   In production: FileDomainStore or a database-backed equivalent.
 *   In tests: MemoryDomainStore.
 *
 * Priority 1: The status engine and schedule engine still run client-side.
 *   The service accepts the client-provided scheduleSnapshot and
 *   statusEngineState and stores them as-is.
 *
 * Priority 2 (future): Move engine execution here so the backend computes
 *   authoritative status independent of any client.
 */
'use strict';

const {
  createAccountFromSeed,
  createEmptyCustomerAccount,
  normalizeAccount,
  recalcAffordabilityDerived
} = require('../domain/factories');

const {
  deriveAllowedActions,
  runStatusEngine
} = require('../domain/status-engine');

const {
  deriveOperativeSchedule
} = require('../domain/loan-engine');

const {
  applyRepayment,
  recordFailedPayment,
  applyPaymentHoliday,
  completePaymentHoliday,
  applyPaymentArrangement,
  breakPaymentArrangement,
  completePaymentArrangement,
  triggerSettlementEvaluation,
  applyForbearanceOverlay,
  exitForbearanceOverlay
} = require('../domain/servicing-engine');

function nowIso() { return new Date().toISOString(); }

function mergeObj(target, src) {
  if (!src || typeof src !== 'object') return target;
  Object.keys(src).forEach(function (k) { target[k] = src[k]; });
  return target;
}

// ── Resolved account projection ───────────────────────────────────────────

/**
 * Build the resolved account view from a raw v3 customerAccount.
 *
 * The resolved view is a flat, UI-ready projection that both frontends can
 * consume directly — no client-side selector logic, active-loan resolution,
 * or schedule conversion required.
 *
 * Shape:
 *   { storageKey, customerId, version, updatedAt,
 *     profile, contact, employment, paymentDetails, affordability,
 *     activeLoan: { loanId, originatedAt, core, emi, summary, status,
 *                   schedule, transactions, arrangements },
 *     loanHistory: [{ loanId, coreStatus, originatedAt, closedAt, principal }],
 *     ops: { notes, contactLog, collectionsFlagged, history } }
 *
 * @param  {Object} account — v3 customerAccount
 * @returns {Object} resolved account view
 */
function buildResolvedAccount(account) {
  var pp  = (account.profile && account.profile.personal)   || {};
  var pe  = (account.profile && account.profile.employment) || {};
  var pc  = (account.profile && account.profile.contact)    || {};
  var pd  = account.paymentDetails || {};
  var aff = (account.affordability && account.affordability.incomeExpenditure) || {};
  var raw = aff.raw     || {};
  var der = aff.derived || {};
  var gran = raw.granular || {};

  // Resolve active loan
  var loans      = account.loans || [];
  var activeLoan = null;
  for (var i = 0; i < loans.length; i++) {
    if (loans[i].loanId === account.activeLoanId) { activeLoan = loans[i]; break; }
  }
  if (!activeLoan && loans.length) activeLoan = loans[0];

  var lc   = (activeLoan && activeLoan.loanCore)          || {};
  var se   = (activeLoan && activeLoan.statusEngineState)  || {};
  var ls   = (activeLoan && activeLoan.loanSummary)        || {};
  var arrs = (activeLoan && activeLoan.arrangements)       || {};
  var ops  = (activeLoan && activeLoan.ops)                || {};

  var snap = (activeLoan && activeLoan.scheduleSnapshot) || [];

  // Run status engine to get fresh allowed/blocked actions
  var allowedActions    = [];
  var blockedActions    = [];
  var actionReasons     = {};
  var operativeSchedule = deriveOperativeSchedule(snap);
  if (activeLoan) {
    try {
      var seNow   = new Date();
      var seState = runStatusEngine(activeLoan, seNow);
      var actResult = deriveAllowedActions(
        activeLoan,
        seState.baseStatus,
        seState.derivedFlags || {},
        seNow
      );
      allowedActions = actResult.allowedActions || [];
      blockedActions = actResult.blockedActions || [];
      actionReasons  = actResult.reasons        || {};
      // Refresh se reference after engine run
      se = activeLoan.statusEngineState || se;
    } catch (e) {
      // Engine error — degrade gracefully, leave empty allowed/blocked
    }
  }

  // Derive EMI: prefer loanSummary, then first non-PH schedule row
  var emi = ls.emi || 0;
  if (!emi) {
    for (var j = 0; j < snap.length; j++) {
      if (!snap[j].ph) { emi = snap[j].emi; break; }
    }
  }

  // Loan history summary (all loans)
  var loanHistory = loans.map(function (l) {
    var lse = l.statusEngineState || {};
    var llc = l.loanCore          || {};
    return {
      loanId:      l.loanId,
      coreStatus:  lse.coreStatus    || 'active',
      originatedAt: l.originatedAt   || null,
      closedAt:    l.closedAt        || null,
      principal:   llc.principal     || 0
    };
  });

  // Ops history — auditTrail formatted for UI consumption
  var auditTrail = (activeLoan && Array.isArray(activeLoan.auditTrail))
    ? activeLoan.auditTrail
    : [];
  var history = auditTrail.map(function (e) {
    return {
      id:        e.id,
      action:    e.action    || e.type   || 'event',
      details:   e.payload   || e.details || {},
      source:    e.source    || e.actor   || 'system',
      timestamp: e.timestamp
    };
  });

  return {
    storageKey: account.storageKey,
    customerId: account.customerId,
    version:    account.version  || 0,
    updatedAt:  account.updatedAt || '',

    profile: {
      fullName:    [pp.firstName, pp.lastName].filter(Boolean).join(' '),
      title:       pp.title       || '',
      firstName:   pp.firstName   || '',
      lastName:    pp.lastName    || '',
      initials:    pp.initials    || '',
      dob:         pp.dob         || '',
      memberSince: pp.memberSince || '',
      loanId:      account.activeLoanId || ''
    },

    contact: {
      email:        pc.email         || '',
      phone:        pc.phone         || '',
      address:      pc.address       || '',
      residentSince: pc.residentSince || ''
    },

    employment: {
      status:          pe.status          || '',
      employer:        pe.employer        || '',
      jobTitle:        pe.jobTitle        || '',
      employmentStart: pe.employmentStart || '',
      annualIncome:    pe.annualIncome    || 0,
      payFrequency:    pe.payFrequency    || '',
      nextPayDate:     pe.nextPayDate     || ''
    },

    paymentDetails: pd,

    affordability: {
      monthlyIncome:    raw.monthlyIncome    || 0,
      housingCosts:     raw.housingCosts     || 0,
      transportCosts:   raw.transportCosts   || 0,
      livingCosts:      raw.livingCosts      || 0,
      otherDebts:       raw.otherDebts       || 0,
      totalExpenditure: der.totalExpenditure || 0,
      disposableIncome: der.disposableIncome || 0,
      granular: {
        incSalary:    gran.incSalary    || 0,
        incSecondary: gran.incSecondary || 0,
        incBenefits:  gran.incBenefits  || 0,
        incOther:     gran.incOther     || 0,
        expRent:      gran.expRent      || 0,
        expCouncil:   gran.expCouncil   || 0,
        expUtilities: gran.expUtilities || 0,
        expFood:      gran.expFood      || 0,
        expTransport: gran.expTransport || 0,
        expChildcare: gran.expChildcare || 0,
        expMobile:    gran.expMobile    || 0,
        expLoans:     gran.expLoans     || 0,
        expCards:     gran.expCards     || 0,
        expBnpl:      gran.expBnpl      || 0,
        expInsurance: gran.expInsurance || 0,
        expSubs:      gran.expSubs      || 0
      }
    },

    activeLoan: activeLoan ? {
      loanId:      activeLoan.loanId,
      originatedAt: activeLoan.originatedAt || null,
      closedAt:    activeLoan.closedAt      || null,

      core: {
        principal:  lc.principal  || 0,
        apr:        lc.apr        || 0,
        termMonths: lc.termMonths || 0,
        startDate:  lc.startDate  || '',
        paidCount:  lc.paidCount  || 0
      },

      emi: emi,

      summary: {
        emi:                  ls.emi                  || emi,
        totalRepayable:       ls.totalRepayable        || 0,
        totalInterest:        ls.totalInterest         || 0,
        outstandingBalance:   ls.outstandingBalance    || 0,
        totalRepaid:          ls.totalRepaid           || 0,
        instalmentsRemaining: ls.instalmentsRemaining  || 0
      },

      status: {
        coreStatus:      se.coreStatus      || 'active',
        displayStatus:   se.displayStatus   || 'active',
        overlays:        se.overlays        || {},
        reasonCodes:     se.reasonCodes     || [],
        lastEvaluatedAt: se.lastEvaluatedAt || ''
      },

      schedule:          snap,
      operativeSchedule: operativeSchedule,
      transactions:      (activeLoan.transactions || []),

      arrangements: {
        paymentHoliday:     arrs.paymentHoliday     || null,
        paymentArrangement: arrs.paymentArrangement || null
      },

      allowedActions: allowedActions,
      blockedActions: blockedActions,
      actionReasons:  actionReasons
    } : null,

    loanHistory: loanHistory,

    ops: {
      notes:             ops.notes             || [],
      contactLog:        ops.contactLog        || [],
      collectionsFlagged: !!(ops.collectionsFlagged),
      history:           history
    }
  };
}

// ── AccountService ────────────────────────────────────────────────────────

/**
 * @param {FileDomainStore|MemoryDomainStore} store
 *   A domain store that implements all repository interfaces.
 */
function AccountService(store) {
  this.store = store;
}

// ── Read operations ───────────────────────────────────────────────────────

/**
 * Return the full account by storageKey, or null if not found.
 * @param  {string} storageKey
 * @returns {Object|null}
 */
AccountService.prototype.getAccount = function (storageKey) {
  return this.store.findByKey(storageKey);
};

/**
 * Return all accounts (used by ops customer directory).
 * @returns {Object[]}
 */
AccountService.prototype.listAccounts = function () {
  return this.store.listAll();
};

// ── Domain-specific read operations ───────────────────────────────────────
// These delegate to the domain repository interface methods on the store.
// In a relational database each method maps to a targeted SELECT query
// rather than loading the full account document.

/**
 * Return the profile sub-document for a customer.
 * @param  {string} storageKey
 * @returns {{ personal, employment, contact } | null}
 */
AccountService.prototype.getCustomerProfile = function (storageKey) {
  return this.store.getProfile(storageKey);
};

/**
 * Return the affordability sub-document.
 * @param  {string} storageKey
 * @returns {{ incomeExpenditure: { raw, derived } } | null}
 */
AccountService.prototype.getAffordability = function (storageKey) {
  return this.store.getAffordability(storageKey);
};

/**
 * Return the payment details sub-document.
 * @param  {string} storageKey
 * @returns {{ card, bank } | null}
 */
AccountService.prototype.getPaymentDetails = function (storageKey) {
  return this.store.getPaymentDetails(storageKey);
};

/**
 * Return the currently active loan, or null.
 * @param  {string} storageKey
 * @returns {Object|null}
 */
AccountService.prototype.getActiveLoan = function (storageKey) {
  return this.store.getActiveLoan(storageKey);
};

/**
 * Return a specific loan by loanId, or null.
 * @param  {string} storageKey
 * @param  {string} loanId
 * @returns {Object|null}
 */
AccountService.prototype.getLoan = function (storageKey, loanId) {
  return this.store.getLoan(storageKey, loanId);
};

/**
 * Return all loans for a customer (active + historical).
 * @param  {string} storageKey
 * @returns {Object[]}
 */
AccountService.prototype.listLoans = function (storageKey) {
  return this.store.listLoans(storageKey);
};

/**
 * Return transactions for a loan.
 * @param  {string} storageKey
 * @param  {string} loanId
 * @returns {Object[]}
 */
AccountService.prototype.listTransactions = function (storageKey, loanId) {
  return this.store.listTransactions(storageKey, loanId);
};

/**
 * Return the schedule snapshot for a loan.
 * @param  {string} storageKey
 * @param  {string} loanId
 * @returns {Object[]}
 */
AccountService.prototype.getSchedule = function (storageKey, loanId) {
  return this.store.getSchedule(storageKey, loanId);
};

// ── Sync / upsert ─────────────────────────────────────────────────────────

/**
 * Reconcile a client-side account with backend state.
 *
 * Rules:
 *  1. If no backend record exists — save the client's account and return it.
 *  2. If backend record exists with a higher version — return backend's
 *     account (client should update its local cache).
 *  3. If client account has a higher or equal version — save the client's
 *     account and return it (client is authoritative on initial migration).
 *
 * @param  {string} storageKey
 * @param  {Object} clientAccount  — v3 account from the client (may be null)
 * @param  {Object} [seed]         — seed object to create account if none exists
 * @returns {{ account: Object, source: 'backend'|'client'|'seed' }}
 */
AccountService.prototype.syncAccount = function (storageKey, clientAccount, seed) {
  var backendAccount = this.store.findByKey(storageKey);

  // Case 1: backend has nothing
  if (!backendAccount) {
    if (clientAccount && clientAccount.storageKey) {
      // Normalise to v3, ensure storageKey is set
      var normalised = normalizeAccount(clientAccount, seed);
      normalised.storageKey = storageKey;
      this.store.save(normalised);
      return { account: normalised, source: 'client' };
    }
    if (seed) {
      var fromSeed = createAccountFromSeed(seed);
      fromSeed.storageKey = storageKey;
      this.store.save(fromSeed);
      return { account: fromSeed, source: 'seed' };
    }
    var empty = createEmptyCustomerAccount();
    empty.storageKey = storageKey;
    this.store.save(empty);
    return { account: empty, source: 'seed' };
  }

  // Case 2: backend has a newer version
  var backendVer = backendAccount.version || 0;
  var clientVer  = clientAccount ? (clientAccount.version || 0) : -1;

  if (backendVer > clientVer) {
    return { account: backendAccount, source: 'backend' };
  }

  // Case 3: client is equal or newer — accept client, persist to backend
  if (clientAccount && clientAccount.storageKey) {
    var accepted = normalizeAccount(clientAccount, seed);
    accepted.storageKey = storageKey;
    this.store.save(accepted);
    return { account: accepted, source: 'client' };
  }

  return { account: backendAccount, source: 'backend' };
};

// ── Command dispatch ──────────────────────────────────────────────────────

/**
 * Apply a command to an account and persist the result.
 *
 * @param  {string} storageKey
 * @param  {{ type, payload, actor }} command
 * @returns {{ account: Object }}
 * @throws Error if account not found
 */
AccountService.prototype.applyCommand = function (storageKey, command) {
  var account = this.store.findByKey(storageKey);
  if (!account) {
    var err = new Error('Account not found: ' + storageKey);
    err.status = 404;
    throw err;
  }

  var type    = command.type    || '';
  var payload = command.payload || {};
  var actor   = command.actor   || 'system';
  var now     = new Date();

  // Route servicing commands through the authoritative engine
  var loan    = getActiveLoan(account);
  var engineResult;

  switch (type) {

    case 'RECORD_PAYMENT':
      if (loan) {
        engineResult = applyRepayment(loan, payload.amount || 0, payload.date, actor, now);
        if (!engineResult.ok) {
          var pmtErr = new Error(engineResult.error || 'Payment could not be applied.');
          pmtErr.status = 422;
          throw pmtErr;
        }
      }
      break;

    case 'RECORD_FAILED_PAYMENT':
      if (loan) {
        recordFailedPayment(loan, payload.amount || 0, payload.date, actor, payload.reason, now);
      }
      break;

    case 'APPLY_PAYMENT_HOLIDAY':
      if (loan) {
        engineResult = applyPaymentHoliday(loan, payload, now, actor);
        if (!engineResult.ok) {
          var phErr = new Error(engineResult.error || 'Payment holiday could not be applied.');
          phErr.status = 422;
          throw phErr;
        }
      }
      break;

    case 'COMPLETE_PAYMENT_HOLIDAY':
      if (loan) {
        engineResult = completePaymentHoliday(loan, now, actor);
        if (!engineResult.ok) {
          var cphErr = new Error(engineResult.error || 'Payment holiday could not be completed.');
          cphErr.status = 422;
          throw cphErr;
        }
      }
      break;

    case 'APPLY_PAYMENT_ARRANGEMENT':
      if (loan) {
        engineResult = applyPaymentArrangement(loan, payload, now, actor);
        if (!engineResult.ok) {
          var paErr = new Error(engineResult.error || 'Payment arrangement could not be applied.');
          paErr.status = 422;
          throw paErr;
        }
      }
      break;

    case 'BREAK_PAYMENT_ARRANGEMENT':
      if (loan) {
        engineResult = breakPaymentArrangement(loan, now, actor);
        if (!engineResult.ok) {
          var bpaErr = new Error(engineResult.error || 'Payment arrangement could not be broken.');
          bpaErr.status = 422;
          throw bpaErr;
        }
      }
      break;

    case 'COMPLETE_PAYMENT_ARRANGEMENT':
      if (loan) {
        engineResult = completePaymentArrangement(loan, now, actor);
        if (!engineResult.ok) {
          var cpaErr = new Error(engineResult.error || 'Payment arrangement could not be completed.');
          cpaErr.status = 422;
          throw cpaErr;
        }
      }
      break;

    case 'SETTLE_EVALUATION':
      if (loan) {
        triggerSettlementEvaluation(loan, now, actor);
      }
      break;

    case 'APPLY_FORBEARANCE_OVERLAY':
      if (loan) {
        engineResult = applyForbearanceOverlay(loan, payload.type, payload, now, actor);
        if (!engineResult.ok) {
          var fovErr = new Error(engineResult.error || 'Forbearance overlay could not be applied.');
          fovErr.status = 422;
          throw fovErr;
        }
      }
      break;

    case 'EXIT_FORBEARANCE_OVERLAY':
      if (loan) {
        engineResult = exitForbearanceOverlay(loan, payload.outcome, payload, now, actor);
        if (!engineResult.ok) {
          var efovErr = new Error(engineResult.error || 'Forbearance overlay could not be exited.');
          efovErr.status = 422;
          throw efovErr;
        }
      }
      break;

    default:
      // All other commands go through the existing handler
      applyCommandToState(account, command);
      break;
  }

  account.version   = (account.version || 0) + 1;
  account.updatedAt = nowIso();

  this.store.save(account);
  return { account: account };
};

// ── Internal command handler ──────────────────────────────────────────────

function getActiveLoan(state) {
  var loans = state.loans || [];
  for (var i = 0; i < loans.length; i++) {
    if (loans[i].loanId === state.activeLoanId) return loans[i];
  }
  return loans[0] || null;
}

/**
 * Pure function: apply a command mutation to a state object.
 * Returns the mutated state (same reference — mutates in place).
 *
 * Handles all non-servicing commands (profile, employment, contact,
 * affordability, payment methods, ops notes, account adjustments).
 * Servicing commands (RECORD_PAYMENT, APPLY_PAYMENT_HOLIDAY, etc.)
 * are routed exclusively through applyCommand's authoritative switch.
 */
function applyCommandToState(state, command) {
  var type    = command.type    || '';
  var payload = command.payload || {};
  var actor   = command.actor   || 'system';
  var now     = nowIso();
  var loan    = getActiveLoan(state);

  switch (type) {

    // ── Customer-level mutations ──────────────────────────────────────────

    case 'UPDATE_PROFILE':
      // 'personal' is the canonical key; 'identity' is the legacy alias kept
      // for backward compatibility with older client dispatches.
      var personalFields = payload.personal || payload.identity;
      if (personalFields) mergeObj(state.profile.personal, personalFields);
      if (payload.contact) mergeObj(state.profile.contact, payload.contact);
      break;

    case 'UPDATE_CONTACT':
      mergeObj(state.profile.contact, payload);
      break;

    case 'UPDATE_EMPLOYMENT':
      mergeObj(state.profile.employment, payload);
      break;

    case 'UPDATE_AFFORDABILITY':
      mergeObj(state.affordability.incomeExpenditure.raw, payload);
      recalcAffordabilityDerived(state);
      break;

    case 'UPDATE_PAYMENT_METHODS':
      if (payload.card) mergeObj(state.paymentDetails.card, payload.card);
      if (payload.bank) mergeObj(state.paymentDetails.bank, payload.bank);
      break;

    // ── Loan core mutations ───────────────────────────────────────────────
    // Note: RECALCULATE_LOAN accepts client-provided scheduleSnapshot because
    // it is an admin tool for correcting origination data, not a servicing action.

    case 'RECALCULATE_LOAN':
      if (loan) {
        if (payload.contract)             mergeObj(loan.loanCore, payload.contract);
        // servicing sub-object sent by the ops UI
        if (payload.servicing) {
          if (payload.servicing.paidCount !== undefined)
            loan.loanCore.paidCount = payload.servicing.paidCount;
          if (payload.servicing.accountStatus) {
            loan.statusEngineState.coreStatus    = payload.servicing.accountStatus;
            loan.statusEngineState.displayStatus = payload.servicing.accountStatus;
          }
        }
        if (payload.principal  !== undefined) loan.loanCore.principal  = payload.principal;
        if (payload.apr        !== undefined) loan.loanCore.apr        = payload.apr;
        if (payload.termMonths !== undefined) loan.loanCore.termMonths = payload.termMonths;
        if (payload.paidCount  !== undefined) loan.loanCore.paidCount  = payload.paidCount;
        if (payload.startDate)               loan.loanCore.startDate  = payload.startDate;
        if (payload.scheduleSnapshot)        loan.scheduleSnapshot    = payload.scheduleSnapshot;
        if (payload.statusEngineState)       loan.statusEngineState   = payload.statusEngineState;
      }
      break;

    // ── Servicing adjustments ─────────────────────────────────────────────

    case 'CHANGE_ACCOUNT_STATUS':
      if (loan) {
        var newSt = payload.status || 'active';
        if (!loan.adjustments)               loan.adjustments = {};
        if (!loan.adjustments.statusChanges) loan.adjustments.statusChanges = [];
        loan.adjustments.statusChanges.push({
          from: loan.statusEngineState.coreStatus,
          to:   newSt, timestamp: now, actor: actor
        });
        loan.statusEngineState.coreStatus    = newSt;
        loan.statusEngineState.displayStatus = newSt;
        if (payload.statusEngineState) loan.statusEngineState = payload.statusEngineState;
      }
      break;

    case 'CHANGE_PAY_DATE':
      if (loan) {
        if (payload.day) loan.loanCore.payDay = payload.day;
        if (payload.contract && payload.contract.startDate) {
          loan.loanCore.startDate = payload.contract.startDate;
        }
        if (!loan.adjustments)                loan.adjustments = {};
        if (!loan.adjustments.dueDateChanges) loan.adjustments.dueDateChanges = [];
        loan.adjustments.dueDateChanges.push({ newDay: payload.day, timestamp: now, actor: actor });
        if (payload.scheduleSnapshot) loan.scheduleSnapshot = payload.scheduleSnapshot;
      }
      break;

    case 'EXTEND_TERM':
      if (loan) {
        var extra = payload.extraMonths || 0;
        loan.loanCore.termMonths = (loan.loanCore.termMonths || 0) + extra;
        if (!loan.adjustments)               loan.adjustments = {};
        if (!loan.adjustments.termExtensions) loan.adjustments.termExtensions = [];
        loan.adjustments.termExtensions.push({
          extraMonths: extra, newTerm: loan.loanCore.termMonths, timestamp: now, actor: actor
        });
        if (payload.scheduleSnapshot)  loan.scheduleSnapshot  = payload.scheduleSnapshot;
        if (payload.statusEngineState) loan.statusEngineState = payload.statusEngineState;
      }
      break;

    case 'WAIVE_INTEREST':
      if (loan) {
        var waiveAmt = payload.amount || 0;
        if (!loan.adjustments)               loan.adjustments = {};
        if (!loan.adjustments.interestWaivers) loan.adjustments.interestWaivers = [];
        loan.adjustments.interestWaivers.push({ amount: waiveAmt, timestamp: now, actor: actor });
        loan.loanCore.principal = Math.max(0, (loan.loanCore.principal || 0) - waiveAmt);
        if (payload.scheduleSnapshot)  loan.scheduleSnapshot  = payload.scheduleSnapshot;
        if (payload.statusEngineState) loan.statusEngineState = payload.statusEngineState;
      }
      break;

    // ── Ops mutations ─────────────────────────────────────────────────────

    case 'ADD_OPS_NOTE':
      if (loan) {
        if (!loan.ops)            loan.ops = { notes: [], contactLog: [], collectionsFlagged: false };
        if (!loan.ops.notes)      loan.ops.notes = [];
        loan.ops.notes.push({ text: payload.text || '', agent: actor, timestamp: now });
      }
      break;

    case 'ADD_CONTACT_ATTEMPT':
      if (loan) {
        if (!loan.ops)            loan.ops = { notes: [], contactLog: [], collectionsFlagged: false };
        if (!loan.ops.contactLog) loan.ops.contactLog = [];
        loan.ops.contactLog.push(Object.assign({}, payload, { agent: actor, timestamp: now }));
      }
      break;

    case 'FLAG_COLLECTIONS':
      if (loan) {
        if (!loan.ops) loan.ops = { notes: [], contactLog: [], collectionsFlagged: false };
        loan.ops.collectionsFlagged = !!payload.flagged;
      }
      break;

    case 'CLOSE_ACCOUNT':
      if (loan) {
        loan.statusEngineState.coreStatus    = 'closed';
        loan.statusEngineState.displayStatus = 'closed';
        loan.closedAt      = now;
        loan.closureReason = payload.reason || 'manual_close';
      }
      break;

    case 'LOG_EVENT':
      if (loan) {
        if (!Array.isArray(loan.auditTrail)) loan.auditTrail = [];
        loan.auditTrail.push({
          id:        'evt-' + Date.now(),
          action:    payload.action  || 'log',
          payload:   payload.details || {},
          source:    actor,
          timestamp: now
        });
      }
      break;

    default:
      // Unknown command — log and ignore (forward-compat)
      console.warn('[AccountService] Unknown command type:', type);
  }

  return state;
}

// ── Resolved view ─────────────────────────────────────────────────────────

/**
 * Return the resolved account view for a given storageKey.
 * Returns null if the account does not exist.
 * @param  {string} storageKey
 * @returns {Object|null}
 */
AccountService.prototype.resolveAccount = function (storageKey) {
  var account = this.store.findByKey(storageKey);
  if (!account) return null;
  return buildResolvedAccount(account);
};

module.exports = AccountService;
