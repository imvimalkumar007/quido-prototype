/**
 * Quido domain factories — Node.js / CommonJS
 *
 * Server-side equivalents of the v3 schema factory functions defined in
 * shared/quido-core.js.  These produce the same canonical shapes so that
 * accounts created or mutated on the backend are structurally identical to
 * those created by the client-side engine.
 *
 * Exports:
 *   createEmptyLoan(loanId)
 *   createEmptyCustomerAccount()
 *   createAccountFromSeed(seed)
 *   recalcAffordabilityDerived(account)
 *   normalizeAccount(raw, seed)   — schema migration (v1/v2 → v3)
 */
'use strict';

const { buildSchedule } = require('./loan-engine');
const { runStatusEngine } = require('./status-engine');

function nowIso() { return new Date().toISOString(); }

function toNumber(v) {
  return Number(String(v || '0').replace(/[^0-9.]/g, '')) || 0;
}

function capAmount(v) {
  return +Math.max(0, v || 0).toFixed(2);
}

function mergeObj(target, src) {
  if (!src || typeof src !== 'object') return target;
  Object.keys(src).forEach(function (k) { target[k] = src[k]; });
  return target;
}

function hydrateLoanFromCore(loan) {
  if (!loan || !loan.loanCore) return loan;
  var lc = loan.loanCore || {};
  if (!lc.principal || !lc.termMonths || !lc.startDate) return loan;
  var built = buildSchedule(
    lc.principal || 0,
    lc.apr || 0,
    lc.termMonths || 0,
    lc.startDate,
    lc.paidCount || 0
  );
  loan.scheduleSnapshot = built.schedule.map(function (row) {
    return {
      n: row.n,
      dueDate: row.dueDate,
      emi: row.emi,
      principal: row.principal,
      interest: row.interest,
      balance: row.balance,
      status: row.status,
      ph: !!row.ph,
      pa: !!row.pa,
      interestPaid: row.status === 'paid' ? row.interest : 0,
      principalPaid: row.status === 'paid' ? row.principal : 0
    };
  });
  loan.loanSummary = {
    emi: built.summary.emi,
    totalRepayable: built.summary.totalRepayable,
    totalInterest: built.summary.totalInterest,
    outstandingBalance: built.summary.outstandingBalance,
    totalRepaid: built.summary.totalRepaid,
    totalInterestPaid: loan.scheduleSnapshot
      .filter(function (row) { return row.status === 'paid'; })
      .reduce(function (acc, row) { return acc + (row.interestPaid || 0); }, 0),
    totalPrincipalPaid: loan.scheduleSnapshot
      .filter(function (row) { return row.status === 'paid'; })
      .reduce(function (acc, row) { return acc + (row.principalPaid || 0); }, 0),
    instalmentsRemaining: built.summary.instalmentsRemaining
  };
  try {
    runStatusEngine(loan, new Date());
  } catch (e) {}
  return loan;
}

function repairBrokenPaymentHoliday(loan) {
  if (!loan || !loan.loanCore || !Array.isArray(loan.scheduleSnapshot)) return false;
  var arrs = loan.arrangements || {};
  var ph = arrs.paymentHoliday;
  if (!ph || !ph.active) return false;

  var snap = loan.scheduleSnapshot;
  var phIdx = Math.max(0, (ph.instalmentN || 1) - 1);
  var target = snap[phIdx];
  if (!target || !target.ph) return false;

  var clearlyBroken = (target.emi || 0) <= 0.009
    || target.status === 'paid'
    || (((target.principal || 0) <= 0.009) && ((target.interest || 0) <= 0.009));
  if (!clearlyBroken) return false;

  var lc = loan.loanCore || {};
  var savedEmi = 0;
  for (var i = phIdx + 1; i < snap.length; i++) {
    if (!snap[i].ph && (snap[i].emi || 0) > 0.009) {
      savedEmi = snap[i].emi || 0;
      break;
    }
  }
  if (!savedEmi) savedEmi = (loan.loanSummary && loan.loanSummary.emi) || 0;
  if (!savedEmi) return false;

  var rMonthly = ((lc.apr || 0) / 100) / 12;
  var openingBal = phIdx > 0
    ? capAmount((snap[phIdx - 1] && snap[phIdx - 1].balance) || 0)
    : capAmount(lc.principal || 0);
  var holidayInterest = capAmount(openingBal * rMonthly);
  var holidayPrincipal = capAmount(Math.min(Math.max(0, savedEmi - holidayInterest), openingBal));
  var carryBal = capAmount(openingBal + holidayInterest);
  var totalRows = Math.max(lc.termMonths || snap.length, phIdx + 1);
  var futureCount = Math.max(0, totalRows - (phIdx + 1));
  var baseDueDate = new Date(target.dueDate || ph.startDate || new Date());
  var rebuiltRows = [];

  target.emi = capAmount(savedEmi);
  target.principal = holidayPrincipal;
  target.interest = holidayInterest;
  target.status = 'ph';
  target.ph = true;
  target.interestPaid = 0;
  target.principalPaid = 0;
  target.remainingDue = 0;
  target.interestRemaining = holidayInterest;
  target.principalRemaining = holidayPrincipal;
  target.balance = carryBal;

  for (var rowIdx = 1; rowIdx <= futureCount; rowIdx++) {
    var interestDue = capAmount(carryBal * rMonthly);
    var principalDue = rowIdx === futureCount
      ? capAmount(carryBal)
      : capAmount(Math.min(Math.max(0, savedEmi - interestDue), carryBal));
    var endBal = capAmount(Math.max(0, carryBal - principalDue));

    rebuiltRows.push({
      n: phIdx + 1 + rowIdx,
      dueDate: new Date(baseDueDate.getFullYear(), baseDueDate.getMonth() + rowIdx, baseDueDate.getDate()).toISOString(),
      emi: capAmount(savedEmi),
      principal: principalDue,
      interest: interestDue,
      balance: endBal,
      status: rowIdx === 1 ? 'current' : 'upcoming',
      ph: false,
      pa: false,
      interestPaid: 0,
      principalPaid: 0,
      interestRemaining: interestDue,
      principalRemaining: principalDue,
      remainingDue: capAmount(savedEmi)
    });

    carryBal = endBal;
  }

  snap.splice(phIdx + 1, Math.max(0, snap.length - (phIdx + 1)), ...rebuiltRows);
  lc.paidCount = Math.max(lc.paidCount || 0, phIdx + 1);
  lc.termMonths = Math.max(lc.termMonths || 0, phIdx + 1 + rebuiltRows.length);
  return true;
}

function repairV3Account(account) {
  if (!account || !Array.isArray(account.loans)) return account;
  for (var i = 0; i < account.loans.length; i++) {
    var loan = account.loans[i];
    var lc = loan && loan.loanCore || {};
    if (!loan) continue;
    var missingSchedule = !loan.scheduleSnapshot || !loan.scheduleSnapshot.length;
    var missingSummary = !loan.loanSummary || !loan.loanSummary.emi;
    if (missingSchedule || missingSummary) {
      hydrateLoanFromCore(loan);
      if (!loan.originatedAt) loan.originatedAt = lc.startDate || nowIso();
      if (loan.closedAt && loan.loanSummary && loan.loanSummary.outstandingBalance > 0.01) {
        loan.closedAt = null;
        loan.closureReason = null;
      }
    }
    if (repairBrokenPaymentHoliday(loan)) {
      try {
        runStatusEngine(loan, new Date());
      } catch (e) {}
    }
  }
  return account;
}

// ── Empty schema factories ────────────────────────────────────────────────

function createEmptyLoan(loanId) {
  var now = nowIso();
  return {
    loanId:         loanId || '',
    originatedAt:   now,
    closedAt:       null,
    settlementDate: null,
    closureReason:  null,

    statusEngineState: {
      baseStatus:            'active',
      servicingOverlay:      null,
      servicingSubStatus:    null,
      forbearanceOverlay:    null,
      resolvedDisplayStatus: 'active',
      reasonCodes:           [],
      derivedFlags:          {},
      lastEvaluatedAt:       now
    },

    loanCore: {
      principal:  0,
      apr:        0,
      termMonths: 0,
      startDate:  '',
      paidCount:  0
    },

      scheduleSnapshot: [],
      partialCredit:    0,
      loanSummary: {
        emi: 0, totalRepayable: 0, totalInterest: 0,
        outstandingBalance: 0, totalRepaid: 0,
        totalInterestPaid: 0, totalPrincipalPaid: 0,
        instalmentsRemaining: 0
      },

    transactions: [],

    arrangements: {
      paymentHoliday:            null,
      paymentArrangement:        null,
      paymentHolidayHistory:     [],
      paymentArrangementHistory: []
    },

    forbearanceOverlay: null,
    forbearanceCases:   [],

    adjustments: {
      interestWaivers: [],
      dueDateChanges:  [],
      termExtensions:  [],
      manualPayments:  [],
      statusChanges:   []
    },

    // Affordability assessment data is customer-level (account.affordability).
    // A loan may reference the snapshot taken at origination via:
    //   affordabilitySnapshotRef: null  (set when loan is originated)

    documents: [
      { type: 'secci',               issuedAt: now },
      { type: 'adequateExplanation', issuedAt: now },
      { type: 'cancellationNotice',  issuedAt: now },
      { type: 'agreement',           signedAt: now }
    ],

    ops: {
      notes:             [],
      contactLog:        [],
      collectionsFlagged: false
    },

    ledger: {
      entries: [],
      totals: {
        principalDue:     0,
        interestDue:      0,
        cashReceived:     0,
        waivedAmount:     0,
        adjustmentAmount: 0
      }
    },

    auditTrail: []
  };
}

function createEmptyCustomerAccount() {
  var now = nowIso();
  return {
    schemaVersion: 3,
    customerId:    '',
    storageKey:    '',
    version:       0,
    updatedAt:     now,

    profile: {
      personal: {
        title: '', firstName: '', lastName: '',
        dob: '', initials: '', memberSince: ''
      },
      employment: {
        status: '', employer: '', jobTitle: '',
        employmentStart: '', annualIncome: 0,
        payFrequency: '', nextPayDate: ''
      },
      contact: {
        email: '', phone: '', address: '', residentSince: ''
      }
    },

    auth: {
      email: '',
      pin: '',
      createdAt: now,
      lastLoginAt: null,
      portalEnabled: false
    },

    application: {
      stage: 'profile_incomplete',
      eligibility: null,
      quote: null,
      requestedLoan: null,
      proxyData: null,
      submittedAt: null,
      reviewedAt: null,
      signedAt: null,
      signature: null,
      decision: null,
      disbursal: {
        status: 'not_requested',
        approvedAt: null,
        approvedBy: null,
        disbursedAt: null,
        disbursedBy: null
      },
      statusHistory: []
    },

    paymentDetails: {
      card: { type: '', last4: '', expiry: '', collectionDayOfMonth: null, active: false },
      bank: { accountHolder: '', bankName: '', sortCodeMasked: '', accountNumberMasked: '', fundedToDate: '' }
    },

    affordability: {
      incomeExpenditure: {
        raw: {
          monthlyIncome: 0, housingCosts: 0,
          transportCosts: 0, livingCosts: 0, otherDebts: 0,
          granular: {
            incSalary: 0, incSecondary: 0, incBenefits: 0, incOther: 0,
            expRent: 0, expCouncil: 0, expUtilities: 0, expFood: 0,
            expTransport: 0, expChildcare: 0, expMobile: 0, expLoans: 0,
            expCards: 0, expBnpl: 0, expInsurance: 0, expSubs: 0
          }
        },
        derived: { totalIncome: 0, totalExpenditure: 0, disposableIncome: 0 },
        snapshots: []
      }
    },

    activeLoanId:       '',
    loans:              [],
    customerAuditTrail: []
  };
}

// ── Derived affordability ─────────────────────────────────────────────────

function recalcAffordabilityDerived(account) {
  var raw = account.affordability.incomeExpenditure.raw;
  var exp = (raw.housingCosts   || 0)
          + (raw.transportCosts || 0)
          + (raw.livingCosts    || 0)
          + (raw.otherDebts     || 0);
  account.affordability.incomeExpenditure.derived = {
    totalIncome:      raw.monthlyIncome || 0,
    totalExpenditure: exp,
    disposableIncome: (raw.monthlyIncome || 0) - exp
  };
}

// ── Seed → v3 account ─────────────────────────────────────────────────────

/**
 * Build a v3 customerAccount from the seed object used in the HTML prototypes.
 * Seed shape (from CUSTOMER_REGISTRY in the HTML files):
 *   { id, storageKey, loanId, initials, memberSince,
 *     profile:           { title, firstName, lastName, dob, email, phone,
 *                          address, employmentStatus, employer, jobTitle,
 *                          employmentStart, annualIncome, payFrequency,
 *                          nextPayDate, residentSince },
 *     incomeExpenditure: { monthlyIncome, housingCosts, transportCosts,
 *                          livingCosts, otherDebts },
 *     loan:              { principal, apr, term, startDate, paidCount,
 *                          accountStatus } }
 */
function createAccountFromSeed(seed) {
  var now = nowIso();
  var sp  = seed.profile           || {};
  var sie = seed.incomeExpenditure || {};
  var sl  = seed.loan              || {};

  // Support both flat (legacy) and v3-structured seed profiles.
  // Flat:       seed.profile.firstName, seed.profile.employmentStatus, …
  // Structured: seed.profile.personal.firstName, seed.profile.employment.status, …
  var spp = sp.personal   || sp;   // personal section or flat fallback
  var spc = sp.contact    || sp;   // contact section or flat fallback
  var spe = sp.employment || sp;   // employment section or flat fallback

  var account         = createEmptyCustomerAccount();
  account.customerId  = seed.id         || seed.storageKey || '';
  account.storageKey  = seed.storageKey || '';
  account.version     = 0;
  account.updatedAt   = now;

  account.profile.personal = {
    title:       spp.title       || '',
    firstName:   spp.firstName   || '',
    lastName:    spp.lastName    || '',
    dob:         spp.dob         || '',
    initials:    seed.initials   || '',
    memberSince: seed.memberSince || spp.memberSince || ''
  };
  account.profile.employment = {
    status:          spe.status || spe.employmentStatus || '',
    employer:        spe.employer        || '',
    jobTitle:        spe.jobTitle        || '',
    employmentStart: spe.employmentStart || '',
    annualIncome:    toNumber(spe.annualIncome || 0),
    payFrequency:    spe.payFrequency    || '',
    nextPayDate:     spe.nextPayDate     || ''
  };
  account.profile.contact = {
    email:         spc.email         || '',
    phone:         spc.phone         || '',
    address:       spc.address       || '',
    residentSince: spc.residentSince || ''
  };
  account.auth = {
    email:         (seed.credentials && seed.credentials.email) || spc.email || '',
    pin:           (seed.credentials && seed.credentials.pin) || '',
    createdAt:     now,
    lastLoginAt:   null,
    portalEnabled: true
  };

  var sg = sie.granular || {};
  account.affordability.incomeExpenditure.raw = {
    monthlyIncome:  sie.monthlyIncome  || 0,
    housingCosts:   sie.housingCosts   || 0,
    transportCosts: sie.transportCosts || 0,
    livingCosts:    sie.livingCosts    || 0,
    otherDebts:     sie.otherDebts     || 0,
    granular: {
      incSalary:    sg.incSalary    || 0,
      incSecondary: sg.incSecondary || 0,
      incBenefits:  sg.incBenefits  || 0,
      incOther:     sg.incOther     || 0,
      expRent:      sg.expRent      || 0,
      expCouncil:   sg.expCouncil   || 0,
      expUtilities: sg.expUtilities || 0,
      expFood:      sg.expFood      || 0,
      expTransport: sg.expTransport || 0,
      expChildcare: sg.expChildcare || 0,
      expMobile:    sg.expMobile    || 0,
      expLoans:     sg.expLoans     || 0,
      expCards:     sg.expCards     || 0,
      expBnpl:      sg.expBnpl      || 0,
      expInsurance: sg.expInsurance || 0,
      expSubs:      sg.expSubs      || 0
    }
  };
  recalcAffordabilityDerived(account);

  var loanId = seed.loanId || 'loan-1';
  var loan   = createEmptyLoan(loanId);
  loan.originatedAt = sl.startDate || now;
  loan.loanCore     = {
    principal:  sl.principal  || 0,
    apr:        sl.apr        || 0,
    termMonths: sl.term       || sl.termMonths || 0,
    startDate:  sl.startDate  || '',
    paidCount:  sl.paidCount  || 0
  };
  hydrateLoanFromCore(loan);
  if (sl.accountStatus && loan.statusEngineState) {
    if (loan.statusEngineState.baseStatus === 'active' || !loan.statusEngineState.baseStatus) {
      loan.statusEngineState.baseStatus = sl.accountStatus;
    }
    if (loan.statusEngineState.coreStatus === 'active' || !loan.statusEngineState.coreStatus) {
      loan.statusEngineState.coreStatus = sl.accountStatus;
    }
    if (loan.statusEngineState.displayStatus) {
      loan.statusEngineState.displayStatus = sl.accountStatus;
    }
    if (loan.statusEngineState.resolvedDisplayStatus === 'active' || !loan.statusEngineState.resolvedDisplayStatus) {
      loan.statusEngineState.resolvedDisplayStatus = sl.accountStatus;
    }
  }

  account.loans        = [loan];
  account.activeLoanId = loanId;
  account.application.stage = 'disbursed';
  account.application.statusHistory = [{
    stage: 'disbursed',
    at: now,
    by: 'seed'
  }];

  return account;
}

// ── Schema migration ──────────────────────────────────────────────────────

/**
 * Detect the schema version of a raw account object and normalise it to v3.
 * v3: has account.loans[]
 * v2: has account.identity + account.loan.contract
 * v1: has account.profile (flat) or account.loanOverrides
 */
function normalizeAccount(raw, seed) {
  if (!raw) return seed ? createAccountFromSeed(seed) : createEmptyCustomerAccount();

  // Already v3
  if (raw.schemaVersion === 3 || Array.isArray(raw.loans)) {
    var v3 = createEmptyCustomerAccount();
    mergeObj(v3, raw);
    return repairV3Account(v3);
  }

  // v2: identity + loan.contract
  if (raw.identity || (raw.loan && raw.loan.contract)) {
    return migrateV2toV3(raw);
  }

  // v1: flat profile / loanOverrides — treat as seed-compatible
  if (raw.profile || raw.loanOverrides) {
    return createAccountFromSeed(Object.assign({}, seed || {}, {
      id: raw.accountId || raw.id || (seed && seed.id),
      storageKey: raw.storageKey || (seed && seed.storageKey),
      profile: raw.profile || {},
      loan: raw.loanOverrides || {}
    }));
  }

  // Unknown — return empty account with storageKey preserved
  var fallback = createEmptyCustomerAccount();
  fallback.storageKey = raw.storageKey || (seed && seed.storageKey) || '';
  return fallback;
}

function migrateV2toV3(v2) {
  var now  = nowIso();
  var lc   = (v2.loan && v2.loan.contract)  || {};
  var svc  = (v2.loan && v2.loan.servicing) || {};
  var id   = v2.identity   || {};
  var emp  = v2.employment || {};
  var con  = v2.contact    || {};
  var aff  = v2.affordability || {};
  var pm   = v2.paymentMethods || {};
  var ops  = v2.ops || {};

  var account = createEmptyCustomerAccount();
  account.schemaVersion = 3;
  account.customerId    = v2.accountId   || v2.storageKey || '';
  account.storageKey    = v2.storageKey  || '';
  account.version       = 1;
  account.updatedAt     = (v2.audit && v2.audit.updatedAt) || now;

  account.profile.personal   = {
    title: id.title || '', firstName: id.firstName || '', lastName: id.lastName || '',
    dob: (v2.personal && v2.personal.dob) || '', initials: id.initials || '', memberSince: id.memberSince || ''
  };
  account.profile.employment = {
    status: emp.status || '', employer: emp.employer || '', jobTitle: emp.jobTitle || '',
    employmentStart: emp.employmentStart || '', annualIncome: emp.annualIncome || 0,
    payFrequency: emp.payFrequency || '', nextPayDate: emp.nextPayDate || ''
  };
  account.profile.contact    = {
    email: con.email || '', phone: con.phone || '',
    address: con.address || '', residentSince: con.residentSince || ''
  };

  account.paymentDetails = {
    card: mergeObj({ type:'', last4:'', expiry:'', collectionDayOfMonth:null, active:false }, pm.card || {}),
    bank: mergeObj({ accountHolder:'', bankName:'', sortCodeMasked:'', accountNumberMasked:'', fundedToDate:'' }, pm.bank || {})
  };

  var vg = (aff.granular) || ((aff.incomeExpenditure && aff.incomeExpenditure.raw && aff.incomeExpenditure.raw.granular)) || {};
  account.affordability.incomeExpenditure.raw = {
    monthlyIncome:  aff.monthlyIncome  || 0,
    housingCosts:   aff.housingCosts   || 0,
    transportCosts: aff.transportCosts || 0,
    livingCosts:    aff.livingCosts    || 0,
    otherDebts:     aff.otherDebts     || 0,
    granular: {
      incSalary:    vg.incSalary    || 0,
      incSecondary: vg.incSecondary || 0,
      incBenefits:  vg.incBenefits  || 0,
      incOther:     vg.incOther     || 0,
      expRent:      vg.expRent      || 0,
      expCouncil:   vg.expCouncil   || 0,
      expUtilities: vg.expUtilities || 0,
      expFood:      vg.expFood      || 0,
      expTransport: vg.expTransport || 0,
      expChildcare: vg.expChildcare || 0,
      expMobile:    vg.expMobile    || 0,
      expLoans:     vg.expLoans     || 0,
      expCards:     vg.expCards     || 0,
      expBnpl:      vg.expBnpl      || 0,
      expInsurance: vg.expInsurance || 0,
      expSubs:      vg.expSubs      || 0
    }
  };
  recalcAffordabilityDerived(account);

  var loanId = id.loanId || v2.accountId || 'loan-1';
  var loan   = createEmptyLoan(loanId);
  loan.originatedAt = (v2.audit && v2.audit.createdAt) || now;
  loan.loanCore = {
    principal:  lc.principal  || 0,
    apr:        lc.apr        || 0,
    termMonths: lc.termMonths || 0,
    startDate:  lc.startDate  || '',
    paidCount:  svc.paidCount || 0
  };
  loan.ops = {
    notes:             Array.isArray(ops.notes)     ? ops.notes     : [],
    contactLog:        Array.isArray(ops.contactLog) ? ops.contactLog : [],
    collectionsFlagged: !!ops.collectionsFlagged
  };
  loan.auditTrail = (Array.isArray(v2.events) ? v2.events : []).map(function (e) {
    return {
      id:        e.id        || ('evt-' + Date.now()),
      action:    e.type      || 'unknown',
      payload:   e.payload   || {},
      source:    e.actor     || 'system',
      timestamp: e.timestamp || now
    };
  });
  loan.statusEngineState.coreStatus    = svc.accountStatus || 'active';
  loan.statusEngineState.displayStatus = svc.accountStatus || 'active';

  account.loans        = [loan];
  account.activeLoanId = loanId;

  return account;
}

// ── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  createEmptyLoan,
  createEmptyCustomerAccount,
  createAccountFromSeed,
  recalcAffordabilityDerived,
  normalizeAccount
};
