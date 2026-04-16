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

const crypto = require('crypto');

const {
  createEmptyLoan,
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
  deriveOperativeSchedule,
  buildSchedule
} = require('../domain/loan-engine');

const decisionService = require('./decision-service');
const { disburseApprovedApplication } = require('./disbursal-service');

const {
  applyRepayment,
  refundPayment,
  rebuildSummary,
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

function hashPassword(plain) {
  return crypto.createHash('sha256').update(String(plain)).digest('hex');
}

function mergeObj(target, src) {
  if (!src || typeof src !== 'object') return target;
  Object.keys(src).forEach(function (k) { target[k] = src[k]; });
  return target;
}

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'customer';
}

function createStorageKey(firstName, lastName) {
  return 'np_public_' + slugify(firstName + '_' + lastName) + '_' + Date.now().toString().slice(-6);
}

function createCustomerId() {
  return 'customer_' + Date.now().toString().slice(-8);
}

function createApplicationLoanId() {
  return 'APP-' + String(Date.now()).slice(-6);
}

function paymentBreakdown(row, partialCredit) {
  if (row && row.ph) {
    return {
      interestPaid: 0,
      principalPaid: 0,
      interestRemaining: +(row.interest || 0).toFixed(2),
      principalRemaining: +(row.principal || 0).toFixed(2),
      remainingDue: 0
    };
  }
  var interestPaid = Math.max(0, +(row && row.interestPaid || 0));
  var principalPaid = Math.max(0, +(row && row.principalPaid || 0));
  if (row && row.status === 'paid') {
    interestPaid = Math.max(interestPaid, +(row.interest || 0));
    principalPaid = Math.max(principalPaid, +(row.principal || 0));
  }
  var credit = Math.max(0, +(partialCredit || 0));
  if (row && row.status !== 'paid' && credit > 0) {
    var interestCredit = Math.min(credit, Math.max(0, +(row.interest || 0) - interestPaid));
    interestPaid += interestCredit;
    credit = Math.max(0, +(credit - interestCredit).toFixed(2));
    var principalCredit = Math.min(credit, Math.max(0, +(row.principal || 0) - principalPaid));
    principalPaid += principalCredit;
  }
  var interestRemaining = Math.max(0, +(((row && row.interest) || 0) - interestPaid).toFixed(2));
  var principalRemaining = Math.max(0, +(((row && row.principal) || 0) - principalPaid).toFixed(2));
  return {
    interestPaid: interestPaid,
    principalPaid: principalPaid,
    interestRemaining: interestRemaining,
    principalRemaining: principalRemaining,
    remainingDue: +(interestRemaining + principalRemaining).toFixed(2)
  };
}

function buildDueSummary(schedule) {
  var rows = Array.isArray(schedule) ? schedule : [];
  var overdueAmount = 0;
  var overdueCount = 0;
  var overdueDate = null;
  var next = null;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row || row.ph || row.status === 'paid') continue;
    var amount = Math.max(0, +(row.remainingDue != null ? row.remainingDue : row.emi || 0));
    if (amount <= 0.01) continue;
    if (row.status === 'overdue') {
      overdueAmount = +(overdueAmount + amount).toFixed(2);
      overdueCount += 1;
      if (!overdueDate) overdueDate = row.dueDate || null;
    } else if (!next) {
      next = row;
    }
  }

  if (overdueCount > 0) {
    return {
      amount: overdueAmount,
      dueDate: overdueDate,
      overdueCount: overdueCount,
      hasOverdue: true
    };
  }

  return {
    amount: next ? Math.max(0, +(next.remainingDue != null ? next.remainingDue : next.emi || 0)) : 0,
    dueDate: next ? (next.dueDate || null) : null,
    overdueCount: 0,
    hasOverdue: false
  };
}

function setPaidCount(loan, paidCount, now, actor) {
  var snap = loan.scheduleSnapshot || [];
  var seState = loan.statusEngineState || {};
  var current = (loan.loanCore && loan.loanCore.paidCount) || 0;
  var target = Math.max(0, Math.min(paidCount || 0, snap.length));
  var status = seState.coreStatus || seState.baseStatus || 'active';

  if ((status === 'closed' || status === 'settled' || loan.closedAt) && target < current) {
    return { ok: false, loan: loan, error: 'Paid instalments cannot be reduced on a closed or settled loan.' };
  }

  loan.loanCore.paidCount = target;
  loan.partialCredit = 0;

  for (var i = 0; i < snap.length; i++) {
    var row = snap[i];
    if (i < target || row.ph) {
      row.status = 'paid';
      row.interestPaid = row.interest || 0;
      row.principalPaid = row.principal || 0;
    } else {
      row.status = (i === target) ? 'current' : 'upcoming';
      row.interestPaid = 0;
      row.principalPaid = 0;
    }
  }

  rebuildSummary(loan);
  runStatusEngine(loan, now);
  if (!Array.isArray(loan.auditTrail)) loan.auditTrail = [];
  loan.auditTrail.push({
    id: 'audit-' + Date.now(),
    action: 'paid_count_adjusted',
    payload: { previousPaidCount: current, paidCount: target },
    actor: actor,
    timestamp: (now || new Date()).toISOString()
  });

  return { ok: true, loan: loan };
}

function getLoanByIdOrActive(account, loanId) {
  var loans = (account && account.loans) || [];
  if (loanId) {
    for (var i = 0; i < loans.length; i++) {
      if (loans[i] && loans[i].loanId === loanId) return loans[i];
    }
  }
  return getActiveLoan(account);
}

function hasTransaction(loan, txnId) {
  var txns = (loan && loan.transactions) || [];
  if (!txnId) return false;
  for (var i = 0; i < txns.length; i++) {
    if (txns[i] && txns[i].id === txnId) return true;
  }
  return false;
}

function replayClientOnlyPayments(backendAccount, clientAccount, now) {
  if (!backendAccount || !clientAccount) return 0;
  var clientLoan = getLoanByIdOrActive(clientAccount, clientAccount.activeLoanId);
  if (!clientLoan || !Array.isArray(clientLoan.transactions)) return 0;
  var backendLoan = getLoanByIdOrActive(backendAccount, clientLoan.loanId || backendAccount.activeLoanId);
  if (!backendLoan) return 0;

  var replayable = clientLoan.transactions.filter(function (txn) {
    if (!txn || !txn.id || hasTransaction(backendLoan, txn.id)) return false;
    if (txn.successful === false || txn.refundedAt || txn.refundTxnId) return false;
    if (['payment', 'partial_payment'].indexOf(txn.type) === -1) return false;
    return +(txn.amount || 0) > 0;
  }).sort(function (a, b) {
    return new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime();
  });

  var applied = 0;
  for (var i = 0; i < replayable.length; i++) {
    var txn = replayable[i];
    var date = txn.date || (now || new Date()).toISOString();
    applyLegacyPartialCreditToSchedule(backendLoan, now);
    var result = applyRepayment(
      backendLoan,
      +(txn.amount || 0),
      date,
      txn.actor || 'customer_ui',
      new Date(date),
      txn.instrument || null,
      txn.id
    );
    if (result && result.ok) applied++;
  }
  if (applied > 0) {
    backendAccount.version = (backendAccount.version || 0) + applied;
    backendAccount.updatedAt = nowIso();
  }
  return applied;
}

function applyLegacyPartialCreditToSchedule(loan, now) {
  var credit = Math.max(0, +(loan && loan.partialCredit || 0));
  if (!loan || credit <= 0) return 0;
  var snap = loan.scheduleSnapshot || [];
  var paidIdx = (loan.loanCore && loan.loanCore.paidCount) || 0;
  var applied = 0;

  for (var i = paidIdx; i < snap.length; i++) {
    var row = snap[i];
    if (!row || row.status === 'paid' || row.ph) continue;
    row.interestPaid = Math.max(0, +(row.interestPaid || 0));
    row.principalPaid = Math.max(0, +(row.principalPaid || 0));

    var interestDue = Math.max(0, +((row.interest || 0) - row.interestPaid).toFixed(2));
    if (interestDue > 0 && credit > 0) {
      var interestPay = Math.min(credit, interestDue);
      row.interestPaid = +((row.interestPaid || 0) + interestPay).toFixed(2);
      credit = +(credit - interestPay).toFixed(2);
      applied = +(applied + interestPay).toFixed(2);
    }

    var principalDue = Math.max(0, +((row.principal || 0) - row.principalPaid).toFixed(2));
    if (principalDue > 0 && credit > 0) {
      var principalPay = Math.min(credit, principalDue);
      row.principalPaid = +((row.principalPaid || 0) + principalPay).toFixed(2);
      credit = +(credit - principalPay).toFixed(2);
      applied = +(applied + principalPay).toFixed(2);
    }

    var remaining = Math.max(0, +((row.interest || 0) + (row.principal || 0) - row.interestPaid - row.principalPaid).toFixed(2));
    if (remaining <= 0.01) row.status = 'paid';
    if (credit <= 0.01) break;
  }

  loan.partialCredit = credit > 0.01 ? credit : 0;
  var paidCount = 0;
  for (var pc = 0; pc < snap.length; pc++) {
    if (snap[pc] && snap[pc].status === 'paid') paidCount++;
    else break;
  }
  if (loan.loanCore) loan.loanCore.paidCount = Math.max(loan.loanCore.paidCount || 0, paidCount);
  rebuildSummary(loan);
  runStatusEngine(loan, now || new Date());
  return applied;
}

function pickValue() {
  for (var i = 0; i < arguments.length; i++) {
    var val = arguments[i];
    if (val !== undefined && val !== null) return val;
  }
  return undefined;
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
  var resolvedAt = new Date();
  var legacyPartialCredit = activeLoan ? Math.max(0, +(activeLoan.partialCredit || 0)) : 0;
  var partialCreditApplied = false;

  // Run status engine to get fresh allowed/blocked actions
  var allowedActions    = [];
  var blockedActions    = [];
  var actionReasons     = {};
  var operativeSchedule = deriveOperativeSchedule(snap, resolvedAt);
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

  var resolvedSchedule = [];
  for (var rs = 0; rs < operativeSchedule.length; rs++) {
    var row = operativeSchedule[rs];
    var creditForRow = (!partialCreditApplied && row.status !== 'paid' && !row.ph)
      ? legacyPartialCredit
      : 0;
    if (creditForRow > 0) partialCreditApplied = true;
    resolvedSchedule.push(Object.assign({}, row, paymentBreakdown(row, creditForRow)));
  }

  var computedSummary = {
    emi: emi,
    totalRepayable: 0,
    totalInterest: 0,
    outstandingBalance: 0,
    totalRepaid: 0,
    totalInterestPaid: 0,
    totalPrincipalPaid: 0,
    instalmentsRemaining: 0
  };
  for (var cs = 0; cs < resolvedSchedule.length; cs++) {
    var sr = resolvedSchedule[cs];
    if (sr.ph) continue;
    computedSummary.totalRepayable += sr.emi || 0;
    computedSummary.totalInterest += sr.interest || 0;
    computedSummary.totalInterestPaid += sr.interestPaid || 0;
    computedSummary.totalPrincipalPaid += sr.principalPaid || 0;
    computedSummary.outstandingBalance += sr.remainingDue || 0;
    if ((sr.remainingDue || 0) > 0.01) computedSummary.instalmentsRemaining += 1;
  }
  computedSummary.totalRepaid = computedSummary.totalInterestPaid + computedSummary.totalPrincipalPaid;
  Object.keys(computedSummary).forEach(function (key) {
    if (typeof computedSummary[key] === 'number') computedSummary[key] = +computedSummary[key].toFixed(2);
  });
  var computedDue = buildDueSummary(resolvedSchedule);

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
      fullName:      [pp.firstName, pp.lastName].filter(Boolean).join(' '),
      title:         pp.title         || '',
      firstName:     pp.firstName     || '',
      lastName:      pp.lastName      || '',
      initials:      pp.initials      || '',
      dob:           pp.dob           || '',
      maritalStatus: pp.maritalStatus || '',
      memberSince:   pp.memberSince   || '',
      loanId:        account.activeLoanId || ''
    },

    contact: {
      email:           pc.email           || '',
      phone:           pc.phone           || '',
      mobileNumber:    pc.mobileNumber    || pc.phone || '',
      address:         pc.address         || '',
      residentSince:   pc.residentSince   || '',
      homeOwnerStatus: pc.homeOwnerStatus || '',
      houseNumber:     pc.houseNumber     || '',
      flatNumber:      pc.flatNumber      || null,
      street:          pc.street          || '',
      city:            pc.city            || '',
      county:          pc.county          || '',
      postCode:        pc.postCode        || '',
      timeAtAddress:   pc.timeAtAddress   || '',
      previousAddress: pc.previousAddress || null
    },

    employment: {
      status:                pe.status                || '',
      employer:              pe.employer              || '',
      employerPhone:         pe.employerPhone         || '',
      jobTitle:              pe.jobTitle              || '',
      lengthOfService:       pe.lengthOfService       || '',
      employmentStart:       pe.employmentStart       || '',
      netMonthlyIncome:      pe.netMonthlyIncome      || 0,
      totalNetMonthlyIncome: pe.totalNetMonthlyIncome || 0,
      annualIncome:          pe.annualIncome          || 0,
      howOftenGetPaid:       pe.howOftenGetPaid       || pe.payFrequency || '',
      whenGetPaid:           pe.whenGetPaid           || pe.nextPayDate  || '',
      payFrequency:          pe.payFrequency          || '',
      nextPayDate:           pe.nextPayDate           || ''
    },

    paymentDetails: pd,

    expenses: (function () {
      var ex = (account.profile && account.profile.expenses) || {};
      return {
        rentMortgage:            ex.rentMortgage            || 0,
        utilitiesBills:          ex.utilitiesBills          || 0,
        councilTax:              ex.councilTax              || 0,
        creditCommitments:       ex.creditCommitments       || 0,
        travelTransport:         ex.travelTransport         || 0,
        subscriptions:           ex.subscriptions           || 0,
        householdExpenses:       ex.householdExpenses       || 0,
        otherExpenses:           ex.otherExpenses           || 0,
        numberOfDependents:      ex.numberOfDependents      || 0,
        incomeExpensesConfirmed: !!ex.incomeExpensesConfirmed
      };
    }()),

    consents: (function () {
      var co = account.consents || {};
      return {
        marketingPhone: !!co.marketingPhone,
        marketingEmail: !!co.marketingEmail,
        marketingSms:   !!co.marketingSms,
        privacyConsent: !!co.privacyConsent,
        consentedAt:    co.consentedAt || null
      };
    }()),

    affordability: {
      monthlyIncome:    pickValue(raw.monthlyIncome, 0),
      housingCosts:     pickValue(raw.housingCosts, 0),
      transportCosts:   pickValue(raw.transportCosts, 0),
      livingCosts:      pickValue(raw.livingCosts, 0),
      otherDebts:       pickValue(raw.otherDebts, 0),
      totalExpenditure: pickValue(der.totalExpenditure, 0),
      disposableIncome: pickValue(der.disposableIncome, 0),
      granular: {
        incSalary:    pickValue(gran.incSalary, 0),
        incSecondary: pickValue(gran.incSecondary, 0),
        incBenefits:  pickValue(gran.incBenefits, 0),
        incOther:     pickValue(gran.incOther, 0),
        expRent:      pickValue(gran.expRent, 0),
        expCouncil:   pickValue(gran.expCouncil, 0),
        expUtilities: pickValue(gran.expUtilities, 0),
        expFood:      pickValue(gran.expFood, 0),
        expTransport: pickValue(gran.expTransport, 0),
        expChildcare: pickValue(gran.expChildcare, 0),
        expMobile:    pickValue(gran.expMobile, 0),
        expLoans:     pickValue(gran.expLoans, 0),
        expCards:     pickValue(gran.expCards, 0),
        expBnpl:      pickValue(gran.expBnpl, 0),
        expInsurance: pickValue(gran.expInsurance, 0),
        expSubs:      pickValue(gran.expSubs, 0)
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
        emi:                  computedSummary.emi,
        totalRepayable:       computedSummary.totalRepayable,
        totalInterest:        computedSummary.totalInterest,
        outstandingBalance:   computedSummary.outstandingBalance,
        totalRepaid:          computedSummary.totalRepaid,
        totalInterestPaid:    computedSummary.totalInterestPaid,
        totalPrincipalPaid:   computedSummary.totalPrincipalPaid,
        instalmentsRemaining: computedSummary.instalmentsRemaining
      },

      due: computedDue,

      status: {
        baseStatus:            se.baseStatus            || se.coreStatus    || 'active',
        servicingOverlay:      se.servicingOverlay      || null,
        servicingSubStatus:    se.servicingSubStatus    || null,
        forbearanceOverlay:    se.forbearanceOverlay    || null,
        resolvedDisplayStatus: se.resolvedDisplayStatus || se.displayStatus || 'active',
        reasonCodes:           se.reasonCodes           || [],
        lastEvaluatedAt:       se.lastEvaluatedAt       || ''
      },

      schedule:          resolvedSchedule,
      operativeSchedule: operativeSchedule.map(function (row) {
        return Object.assign({}, row, paymentBreakdown(row));
      }),
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

    application: (function () {
      var app = account.application || {};
      var dec = app.decision || {};
      return {
        stage:          app.stage          || null,
        submittedAt:    app.submittedAt    || null,
        signedAt:       app.signedAt       || null,
        quote:          app.quote          || null,
        approved:       dec.approved       || false,
        decidedAt:      dec.decidedAt      || null,
        riskScore:      dec.riskScore      != null ? dec.riskScore : null,
        scoreBreakdown: dec.scoreBreakdown || [],
        aprTier:        dec.aprTier        || null,
        reasons:        dec.reasons        || [],
      };
    }()),

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
  this.publicContactMessages = [];
}

// ── Read operations ───────────────────────────────────────────────────────

/**
 * Return the full account by storageKey, or null if not found.
 * @param  {string} storageKey
 * @returns {Object|null}
 */
AccountService.prototype.getAccount = function (storageKey) {
  var account = this.store.findByKey(storageKey);
  if (!account) return null;
  var repaired = normalizeAccount(account);
  repaired.storageKey = storageKey;
  this.store.save(repaired);
  return repaired;
};

/**
 * Return all accounts (used by ops customer directory).
 * @returns {Object[]}
 */
AccountService.prototype.listAccounts = function () {
  return this.store.listAll();
};

AccountService.prototype.findByAuth = function (email, credential) {
  var accounts = this.store.listAll();
  var needle = String(email || '').trim().toLowerCase();
  var credStr = String(credential || '');
  for (var i = 0; i < accounts.length; i++) {
    var account = normalizeAccount(accounts[i]);
    var auth = account.auth || {};
    if (String(auth.email || '').trim().toLowerCase() !== needle) continue;
    // Accept legacy plain PIN match, or SHA-256 password hash match
    var pinMatch  = credStr && String(auth.pin || '') === credStr;
    var hashMatch = credStr && auth.passwordHash && hashPassword(credStr) === String(auth.passwordHash);
    if (pinMatch || hashMatch) {
      auth.lastLoginAt = nowIso();
      account.auth = auth;
      this.store.save(account);
      return account;
    }
  }
  return null;
};

AccountService.prototype.createPublicProfile = function (payload) {
  var email = String(payload.email || '').trim().toLowerCase();
  // Public applications use the same 4-digit PIN as the customer portal.
  // Keep password support only so old prototype records remain readable.
  var password = String(payload.password || '').trim();
  var pin      = String(payload.pin || '').trim();

  if (!email) {
    var err = new Error('Email is required.');
    err.status = 400;
    throw err;
  }
  if (!password && !pin) {
    var credErr = new Error('A 4-digit PIN is required.');
    credErr.status = 400;
    throw credErr;
  }
  if (password) {
    if (password.length < 8 || !/\d/.test(password)) {
      var pwErr = new Error('Password must be at least 8 characters and contain at least one digit.');
      pwErr.status = 400;
      throw pwErr;
    }
  } else {
    if (!/^\d{4}$/.test(pin)) {
      var pinErr = new Error('PIN must be 4 digits.');
      pinErr.status = 400;
      throw pinErr;
    }
  }

  // Check if email already exists; return existing account if credentials match
  var all = this.store.listAll();
  for (var i = 0; i < all.length; i++) {
    var norm = normalizeAccount(all[i]);
    var auth = norm.auth || {};
    var storedEmail = String(auth.email || '').trim().toLowerCase();
    if (storedEmail !== email) continue;
    var credMatch = password
      ? (hashPassword(password) === String(auth.passwordHash || '') || String(auth.pin || '') === password)
      : (String(auth.pin || '') === pin);
    if (credMatch) return { account: norm, created: false };
    var dupErr2 = new Error('An account with this email already exists.');
    dupErr2.status = 409;
    throw dupErr2;
  }

  var account = createEmptyCustomerAccount();
  account.customerId = createCustomerId();
  account.storageKey = createStorageKey(payload.firstName, payload.lastName);

  // Personal identity
  account.profile.personal = {
    title:        payload.title        || '',
    firstName:    payload.firstName    || '',
    lastName:     payload.lastName     || '',
    dob:          payload.dateOfBirth  || payload.dob || '',
    maritalStatus:payload.maritalStatus || '',
    initials:     ((payload.firstName || '').charAt(0) + (payload.lastName || '').charAt(0)).toUpperCase(),
    memberSince:  ''
  };

  // Contact — structured address fields from 3-step form, fallback to legacy single-field
  var addrLine = [payload.houseNumber, payload.flatNumber, payload.street, payload.city, payload.county, payload.postCode].filter(Boolean).join(', ');
  account.profile.contact = {
    email:           email,
    phone:           payload.mobileNumber || payload.phone || '',
    mobileNumber:    payload.mobileNumber || payload.phone || '',
    // Structured address
    homeOwnerStatus: payload.homeOwnerStatus  || '',
    houseNumber:     payload.houseNumber      || '',
    flatNumber:      payload.flatNumber       || null,
    street:          payload.street           || '',
    city:            payload.city             || '',
    county:          payload.county           || '',
    postCode:        payload.postCode         || '',
    postcodeValidation: payload.postcodeValidation || null,
    timeAtAddress:   payload.timeAtAddress    || '',
    previousAddress: payload.previousAddress  || null,
    // Legacy single-line fallback for existing code that reads contact.address
    address:         payload.address || addrLine,
    residentSince:   payload.residentSince || ''
  };

  // Employment
  account.profile.employment = {
    status:           payload.employmentStatus || '',
    employer:         payload.employer         || '',
    employerPhone:    payload.employerPhone     || '',
    jobTitle:         payload.jobTitle          || '',
    lengthOfService:  payload.lengthOfService   || '',
    employmentStart:  payload.employmentStart   || '',
    netMonthlyIncome: Number(payload.netMonthlyIncome || 0),
    totalNetMonthlyIncome: Number(payload.totalNetMonthlyIncome || 0),
    howOftenGetPaid:  payload.howOftenGetPaid   || '',
    whenGetPaid:      payload.whenGetPaid        || '',
    // Legacy fields
    annualIncome:     Number(payload.annualIncome || (payload.netMonthlyIncome || 0) * 12),
    payFrequency:     payload.payFrequency || payload.howOftenGetPaid || 'Monthly',
    nextPayDate:      payload.nextPayDate || ''
  };

  // Expenses — store in affordability and in a dedicated expenses block
  var exp = payload.expenses || {};
  var rentMortgage      = Number(exp.rentMortgage      || 0);
  var utilitiesBills    = Number(exp.utilitiesBills    || 0);
  var councilTax        = Number(exp.councilTax        || 0);
  var creditCommitments = Number(exp.creditCommitments || 0);
  var travelTransport   = Number(exp.travelTransport   || 0);
  var subscriptions     = Number(exp.subscriptions     || 0);
  var householdExpenses = Number(exp.householdExpenses || 0);
  var otherExpenses     = Number(exp.otherExpenses     || 0);
  var housingCosts   = rentMortgage + utilitiesBills + councilTax;
  var livingCosts    = subscriptions + householdExpenses + otherExpenses;
  var transportCosts = travelTransport;
  var otherDebts     = creditCommitments;
  var netMonthly     = Number(payload.netMonthlyIncome || 0);

  account.profile.expenses = {
    rentMortgage, utilitiesBills, councilTax, creditCommitments,
    travelTransport, subscriptions, householdExpenses, otherExpenses,
    numberOfDependents:      Number(payload.numberOfDependents || 0),
    incomeExpensesConfirmed: !!payload.incomeExpensesConfirmed
  };

  account.affordability.incomeExpenditure.raw.monthlyIncome  = netMonthly;
  account.affordability.incomeExpenditure.raw.housingCosts   = housingCosts;
  account.affordability.incomeExpenditure.raw.livingCosts    = livingCosts;
  account.affordability.incomeExpenditure.raw.transportCosts = transportCosts;
  account.affordability.incomeExpenditure.raw.otherDebts     = otherDebts;
  account.affordability.incomeExpenditure.raw.granular = {
    expRent: rentMortgage, expUtilities: utilitiesBills, expCouncil: councilTax,
    expLoans: creditCommitments, expTransport: travelTransport, expSubs: subscriptions,
    expHousehold: householdExpenses, expOther: otherExpenses,
    incSalary: netMonthly, incSecondary: 0, incBenefits: 0, incOther: 0
  };
  recalcAffordabilityDerived(account);

  // Consents
  account.consents = {
    marketingPhone: !!(payload.marketingConsents && payload.marketingConsents.phone),
    marketingEmail: !!(payload.marketingConsents && payload.marketingConsents.email),
    marketingSms:   !!(payload.marketingConsents && payload.marketingConsents.sms),
    privacyConsent: !!payload.privacyConsent,
    consentedAt:    nowIso()
  };

  account.auth = {
    email:        email,
    pin:          pin || '',
    passwordHash: password ? hashPassword(password) : '',
    createdAt:    nowIso(),
    lastLoginAt:  null,
    portalEnabled: false
  };
  account.application.stage = 'profile_created';
  account.application.statusHistory = [{ stage: 'profile_created', at: nowIso(), by: 'public_site' }];
  this.store.save(account);
  return { account: account, created: true };
};

AccountService.prototype.calculatePublicQuote = function (payload) {
  return decisionService.evaluateApplication(payload);
};

function cleanContactField(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength || 500);
}

function buildContactMessage(payload, source) {
  payload = payload || {};
  var name = cleanContactField(payload.name || payload.contactName, 120);
  var email = cleanContactField(payload.email || payload.contactEmail, 160).toLowerCase();
  var reason = cleanContactField(payload.reason, 80);
  var message = cleanContactField(payload.message, 5000);
  if (!name) {
    var nameErr = new Error('Full name is required.');
    nameErr.status = 400;
    throw nameErr;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    var emailErr = new Error('A valid email address is required.');
    emailErr.status = 400;
    throw emailErr;
  }
  if (!reason) {
    var reasonErr = new Error('Reason for contact is required.');
    reasonErr.status = 400;
    throw reasonErr;
  }
  if (!message || message.length < 10) {
    var messageErr = new Error('Message must be at least 10 characters.');
    messageErr.status = 400;
    throw messageErr;
  }
  return {
    id: 'contact-' + Date.now(),
    createdAt: nowIso(),
    source: source || 'public_site',
    status: 'received',
    customerType: cleanContactField(payload.customerType || payload.customer, 30),
    reason: reason,
    name: name,
    email: email,
    mobile: cleanContactField(payload.mobile || payload.contactMobile, 40),
    loanId: cleanContactField(payload.loanId, 60),
    message: message
  };
}

AccountService.prototype.submitContactMessage = function (storageKey, payload, actor) {
  var source = storageKey ? 'customer_portal' : 'public_site';
  var contact = buildContactMessage(payload, source);
  var now = contact.createdAt;

  if (!storageKey) {
    this.publicContactMessages.push(contact);
    return { contact: contact };
  }

  var account = this.store.findByKey(storageKey);
  if (!account) {
    var err = new Error('Account not found: ' + storageKey);
    err.status = 404;
    throw err;
  }
  account = normalizeAccount(account);
  account.storageKey = storageKey;

  if (!Array.isArray(account.contactMessages)) account.contactMessages = [];
  account.contactMessages.push(contact);

  var loan = getActiveLoan(account);
  if (loan) {
    if (!loan.ops) loan.ops = { notes: [], contactLog: [], collectionsFlagged: false };
    if (!Array.isArray(loan.ops.contactLog)) loan.ops.contactLog = [];
    loan.ops.contactLog.push({
      type: 'contact_form',
      reason: contact.reason,
      name: contact.name,
      email: contact.email,
      mobile: contact.mobile,
      loanId: contact.loanId,
      message: contact.message,
      agent: actor || 'customer_ui',
      timestamp: now
    });
    if (!Array.isArray(loan.auditTrail)) loan.auditTrail = [];
    loan.auditTrail.push({
      id: 'evt-' + Date.now(),
      action: 'CONTACT_FORM_SUBMITTED',
      payload: {
        contactId: contact.id,
        reason: contact.reason,
        loanId: contact.loanId,
        message: contact.message
      },
      source: actor || 'customer_ui',
      timestamp: now
    });
  }

  account.version = (account.version || 0) + 1;
  account.updatedAt = now;
  this.store.save(account);
  return { contact: contact, account: account };
};

AccountService.prototype.submitApplication = function (storageKey, payload) {
  var account = this.getAccount(storageKey);
  if (!account) {
    var err = new Error('Account not found: ' + storageKey);
    err.status = 404;
    throw err;
  }

  // Accept I&E at top-level, nested under affordability, or fall back to stored account values
  var storedRaw = (account.affordability && account.affordability.incomeExpenditure && account.affordability.incomeExpenditure.raw) || {};
  var aff = payload.affordability || {};
  var monthlyIncome  = Number(aff.monthlyIncome  || payload.monthlyIncome  || storedRaw.monthlyIncome  || 0);
  var housingCosts   = Number(aff.housingCosts   || payload.housingCosts   || storedRaw.housingCosts   || 0);
  var livingCosts    = Number(aff.livingCosts    || payload.livingCosts    || storedRaw.livingCosts    || 0);
  var transportCosts = Number(aff.transportCosts || payload.transportCosts || storedRaw.transportCosts || 0);
  var otherDebts     = Number(aff.otherDebts     || payload.otherDebts     || storedRaw.otherDebts     || 0);

  account.affordability.incomeExpenditure.raw.monthlyIncome  = monthlyIncome;
  account.affordability.incomeExpenditure.raw.housingCosts   = housingCosts;
  account.affordability.incomeExpenditure.raw.livingCosts    = livingCosts;
  account.affordability.incomeExpenditure.raw.transportCosts = transportCosts;
  account.affordability.incomeExpenditure.raw.otherDebts     = otherDebts;
  // Persist granular I&E if supplied from the application form
  var gran = payload.granular || {};
  if (Object.keys(gran).length) {
    var raw = account.affordability.incomeExpenditure.raw;
    if (!raw.granular) raw.granular = {};
    var g = raw.granular;
    var gKeys = ['incSalary','incSecondary','incBenefits','incOther','expRent','expCouncil','expUtilities','expFood','expTransport','expChildcare','expMobile','expLoans','expCards','expBnpl','expInsurance','expSubs'];
    gKeys.forEach(function(k){ if (gran[k] !== undefined) g[k] = Number(gran[k]) || 0; });
  }
  recalcAffordabilityDerived(account);

  account.profile.personal.dob = payload.dob || account.profile.personal.dob;
  account.profile.contact.address = payload.address || account.profile.contact.address;
  account.profile.contact.email = payload.email || account.profile.contact.email;
  account.profile.contact.phone = payload.phone || account.profile.contact.phone;
  account.profile.employment.status = payload.employmentStatus || account.profile.employment.status;
  account.profile.employment.employer = payload.employer || account.profile.employment.employer;
  account.profile.employment.jobTitle = payload.jobTitle || account.profile.employment.jobTitle;
  account.profile.employment.employmentStart = payload.employmentStart || account.profile.employment.employmentStart;
  account.profile.employment.annualIncome = Number(payload.annualIncome || account.profile.employment.annualIncome || 0);

  var decision = decisionService.evaluateApplication({
    amount:           payload.amount,
    termMonths:       payload.termMonths,
    monthlyIncome:    monthlyIncome,
    housingCosts:     housingCosts,
    livingCosts:      livingCosts,
    transportCosts:   transportCosts,
    otherDebts:       otherDebts,
    dob:              account.profile.personal.dob,
    ukResident:       !!payload.ukResident,
    gainfullyEmployed:!!payload.gainfullyEmployed,
    employmentStatus: account.profile.employment.status || '',
    employmentStart:  account.profile.employment.employmentStart || '',
    proxyData:        payload.proxyData || {},
  });

  account.application.stage = decision.stage;
  account.application.eligibility = {
    ukResident: !!payload.ukResident,
    gainfullyEmployed: !!payload.gainfullyEmployed,
    age: account.profile.personal.dob
  };
  account.application.proxyData = payload.proxyData || {};
  account.application.quote = decision.quote;
  account.application.requestedLoan = {
    amount: decision.quote.amount,
    termMonths: decision.quote.termMonths,
    apr: decision.quote.apr,
    purpose: payload.purpose || 'Personal loan'
  };
  account.application.submittedAt = nowIso();
  account.application.decision = {
    approved:       decision.approved,
    stage:          decision.stage,
    reasons:        decision.reasons,
    riskScore:      decision.riskScore,
    scoreBreakdown: decision.scoreBreakdown,
    affordability:  decision.affordability,
    decidedAt:      nowIso(),
  };
  account.application.disbursal = {
    status: decision.approved ? 'awaiting_signature' : 'not_requested',
    approvedAt: null,
    approvedBy: null,
    disbursedAt: null,
    disbursedBy: null
  };
  account.application.statusHistory = account.application.statusHistory || [];
  account.application.statusHistory.push({ stage: decision.stage, at: nowIso(), by: 'decision_engine' });

  if (decision.approved) {
    var offerLoan = createEmptyLoan(createApplicationLoanId());
    offerLoan.loanCore = {
      principal: decision.quote.amount,
      apr: decision.quote.apr,
      termMonths: decision.quote.termMonths,
      startDate: nowIso(),
      paidCount: 0
    };
    var built = buildSchedule(decision.quote.amount, decision.quote.apr, decision.quote.termMonths, offerLoan.loanCore.startDate, 0);
    offerLoan.scheduleSnapshot = built.schedule.map(function (row) {
      return {
        n: row.n,
        dueDate: row.dueDate,
        emi: row.emi,
        principal: row.principal,
        interest: row.interest,
        balance: row.balance,
        status: row.status,
        ph: false,
        pa: false,
        interestPaid: 0,
        principalPaid: 0,
        interestRemaining: row.interest,
        principalRemaining: row.principal,
        remainingDue: row.emi
      };
    });
    offerLoan.loanSummary = {
      emi: built.summary.emi,
      totalRepayable: built.summary.totalRepayable,
      totalInterest: built.summary.totalInterest,
      outstandingBalance: built.summary.outstandingBalance,
      totalRepaid: 0,
      totalInterestPaid: 0,
      totalPrincipalPaid: 0,
      instalmentsRemaining: built.summary.instalmentsRemaining
    };
    account.application.offerPreview = {
      loanId: offerLoan.loanId,
      schedule: offerLoan.scheduleSnapshot,
      summary: offerLoan.loanSummary
    };
  } else {
    account.application.offerPreview = null;
  }

  this.store.save(account);
  return { account: account, decision: decision };
};

AccountService.prototype.signApplication = function (storageKey, payload) {
  var account = this.getAccount(storageKey);
  if (!account) {
    var err = new Error('Account not found: ' + storageKey);
    err.status = 404;
    throw err;
  }
  if (!account.application || !account.application.decision || !account.application.decision.approved) {
    var appErr = new Error('No approved application is available to sign.');
    appErr.status = 422;
    throw appErr;
  }
  if (!payload.acceptedTerms || !payload.acceptedPrivacy) {
    var consentErr = new Error('Terms and privacy acknowledgements are required.');
    consentErr.status = 422;
    throw consentErr;
  }
  if (!String(payload.fullName || '').trim()) {
    var nameErr = new Error('Full name is required to sign the application.');
    nameErr.status = 422;
    throw nameErr;
  }
  account.application.reviewedAt = nowIso();
  account.application.signedAt = nowIso();
  account.application.signature = {
    fullName: payload.fullName || '',
    acceptedTerms: !!payload.acceptedTerms,
    acceptedPrivacy: !!payload.acceptedPrivacy,
    ipAddress: payload.ipAddress || '',
    signedAt: nowIso()
  };
  // Store bank details provided at signing
  if (payload.bank && payload.bank.accountNumber) {
    account.paymentDetails = account.paymentDetails || {};
    account.paymentDetails.bank = Object.assign(account.paymentDetails.bank || {}, {
      accountHolder:       String(payload.bank.accountHolder || '').trim(),
      bankName:            String(payload.bank.bankName || '').trim(),
      sortCode:            String(payload.bank.sortCode || '').trim(),
      accountNumber:       String(payload.bank.accountNumber || '').trim(),
      accountNumberMasked: '····' + String(payload.bank.accountNumber || '').slice(-4),
      sortCodeMasked:      String(payload.bank.sortCode || '').replace(/\d(?=\d{2})/g, '·'),
      fundedToDate:        null
    });
  }
  account.application.stage = 'signed_awaiting_payment_details';
  account.application.disbursal.status = 'awaiting_payment_details';
  account.application.statusHistory = account.application.statusHistory || [];
  account.application.statusHistory.push({ stage: 'signed_awaiting_payment_details', at: nowIso(), by: 'customer' });
  this.store.save(account);
  return { account: account };
};

AccountService.prototype.saveCardDetails = function (storageKey, card) {
  var account = this.getAccount(storageKey);
  if (!account) { var e = new Error('Account not found.'); e.status = 404; throw e; }
  var raw = String(card.cardNumber || '').replace(/\s/g, '');
  if (!raw || raw.length < 13) { var e2 = new Error('A valid card number is required.'); e2.status = 400; throw e2; }
  account.paymentDetails = account.paymentDetails || {};
  account.paymentDetails.card = {
    type:                card.cardType || 'Debit',
    last4:               raw.slice(-4),
    cardNumberMasked:    '····  ····  ····  ' + raw.slice(-4),
    expiry:              String(card.expiry || '').trim(),
    cardHolder:          String(card.cardHolder || '').trim(),
    collectionDayOfMonth: 1,
    active:              true
  };
  if (account.application && account.application.signedAt && account.paymentDetails.bank && account.paymentDetails.bank.accountNumber) {
    account.application.stage = 'signed_pending_disbursal';
    account.application.disbursal = account.application.disbursal || {};
    account.application.disbursal.status = 'pending_ops_approval';
    account.application.paymentDetailsCompletedAt = nowIso();
    account.application.statusHistory = account.application.statusHistory || [];
    account.application.statusHistory.push({ stage: 'signed_pending_disbursal', at: nowIso(), by: 'customer' });
  }
  this.store.save(account);
  return { account: account };
};

AccountService.prototype.listApplications = function (stage) {
  return this.store.listAll().map(normalizeAccount).filter(function (account) {
    if (!account.application || !account.application.stage) return false;
    return stage ? account.application.stage === stage : true;
  });
};

AccountService.prototype.approveDisbursal = function (storageKey, actor) {
  var account = this.getAccount(storageKey);
  if (!account) {
    var err = new Error('Account not found: ' + storageKey);
    err.status = 404;
    throw err;
  }
  if (!account.application || account.application.stage !== 'signed_pending_disbursal') {
    var stageErr = new Error('Application is not ready for disbursal approval.');
    stageErr.status = 422;
    throw stageErr;
  }
  disburseApprovedApplication(account, actor || 'ops_ui');
  this.store.save(account);
  return { account: account };
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
 *  2. If backend record exists with a higher or equal version — return backend's
 *     account (client should update its local cache).
 *  3. If client account has a higher version — save the client's
 *     account and return it.
 *
 * @param  {string} storageKey
 * @param  {Object} clientAccount  — v3 account from the client (may be null)
 * @param  {Object} [seed]         — seed object to create account if none exists
 * @returns {{ account: Object, source: 'backend'|'client'|'seed' }}
 */
AccountService.prototype.syncAccount = function (storageKey, clientAccount, seed) {
  var now = new Date();
  var backendAccount = this.store.findByKey(storageKey);

  if (backendAccount) {
    var repairedBackend = normalizeAccount(backendAccount, seed);
    repairedBackend.storageKey = storageKey;
    backendAccount = repairedBackend;
    // Note: do not save yet — we save the final winner below with fresh status
  }

  var winner;
  var source;

  // Case 1: backend has nothing
  if (!backendAccount) {
    if (clientAccount && clientAccount.storageKey) {
      winner = normalizeAccount(clientAccount, seed);
      winner.storageKey = storageKey;
      source = 'client';
    } else if (seed) {
      winner = createAccountFromSeed(seed);
      winner.storageKey = storageKey;
      source = 'seed';
    } else {
      winner = createEmptyCustomerAccount();
      winner.storageKey = storageKey;
      source = 'seed';
    }
  } else {
    // Existing accounts are backend-authoritative. Browser localStorage can be
    // stale or device-specific, so it must never win a sync just because its
    // local version number is higher.
    replayClientOnlyPayments(backendAccount, clientAccount, now);
    winner = backendAccount;
    source = 'backend';
  }

  // Always refresh status engine on every loan so the stored state is never stale.
  // This is the single source of truth — the frontend must never rely on cached
  // statusEngineState from a previous write.
  var winnerLoans      = winner.loans || [];
  var winnerActiveLoanId = winner.activeLoanId;
  for (var i = 0; i < winnerLoans.length; i++) {
    var l = winnerLoans[i];
    if (!winnerActiveLoanId || l.loanId === winnerActiveLoanId) {
      try { runStatusEngine(l, now); } catch (e) { /* degrade gracefully */ }
      if (!winnerActiveLoanId) break;
    }
  }

  this.store.save(winner);
  return { account: winner, source: source };
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
        applyLegacyPartialCreditToSchedule(loan, now);
        engineResult = applyRepayment(loan, payload.amount || 0, payload.date, actor, now, payload.instrument, payload.transactionId || payload.id);
        if (!engineResult.ok) {
          var pmtErr = new Error(engineResult.error || 'Payment could not be applied.');
          pmtErr.status = 422;
          throw pmtErr;
        }
      }
      break;

    case 'SET_PAID_COUNT':
      if (loan) {
        engineResult = setPaidCount(loan, payload.paidCount, now, actor);
        if (!engineResult.ok) {
          var spcErr = new Error(engineResult.error || 'Paid instalment count could not be adjusted.');
          spcErr.status = 422;
          throw spcErr;
        }
      }
      break;

    case 'REFUND_PAYMENT':
      if (loan) {
        engineResult = refundPayment(loan, payload.txnId, actor, now, payload.reason);
        if (!engineResult.ok) {
          var refundErr = new Error(engineResult.error || 'Payment could not be refunded.');
          refundErr.status = 422;
          throw refundErr;
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
        loan.ops.notes.push({
          text: payload.text || '',
          reason: payload.reason || '',
          agent: actor,
          timestamp: now
        });
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
  var account = this.getAccount(storageKey);
  if (!account) return null;
  return buildResolvedAccount(account);
};

/**
 * Returns a live-computed summary for every account that has a loan.
 * Uses buildResolvedAccount (which runs the status engine) rather than
 * reading stale stored statusEngineState — so the status always reflects
 * the current state of the loan.
 */
AccountService.prototype.listAccountSummaries = function () {
  return this.listAccounts()
    .filter(function (a) { return !!(a.activeLoanId || (a.loans && a.loans.length)); })
    .map(function (a) {
      var r  = buildResolvedAccount(a);
      var al = r.activeLoan  || {};
      var pp = r.profile     || {};
      var pc = r.contact     || {};
      return {
        storageKey:       a.storageKey,
        customerId:       a.customerId,
        version:          a.version   || 0,
        updatedAt:        a.updatedAt || '',
        name:             pp.fullName || [pp.firstName, pp.lastName].filter(Boolean).join(' '),
        initials:         pp.initials || '',
        email:            pc.email    || '',
        phone:            pc.phone    || '',
        dob:              pp.dob      || '',
        address:          pc.address  || '',
        loanId:           a.activeLoanId || '',
        loanStatus:       (al.status && (al.status.resolvedDisplayStatus || al.status.baseStatus || al.status.coreStatus)) || 'active',
        applicationStage: (a.application && a.application.stage) || '',
        outstanding:      (al.summary && al.summary.outstandingBalance) || 0,
        originatedAt:     al.originatedAt || ''
      };
    });
};

module.exports = AccountService;
