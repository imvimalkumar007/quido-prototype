/**
 * NovaPay Shared Logic Core — v3.0
 * Vanilla JS IIFE. Works on file:// (no ES module import required).
 * Load order: novapay-core.js must come AFTER the four engine files.
 * Exposes: window.NovaPay (merges into any object already placed there
 *          by the engine files)
 *
 * Schema v3 canonical structure:
 *   customerAccount { customerId, storageKey, version, updatedAt,
 *     profile { personal, employment, contact },
 *     paymentDetails { card, bank },
 *     affordability { incomeExpenditure { raw, derived, snapshots } },
 *     activeLoanId, loans [ { loanId, loanCore, scheduleSnapshot,
 *       loanSummary, statusEngineState, transactions, arrangements,
 *       adjustments, documents, ops, auditTrail, … } ],
 *     customerAuditTrail }
 */
;(function (global) {
  'use strict';

  // Merge into the NovaPay namespace already seeded by engine files
  var NovaPay = global.NovaPay || (global.NovaPay = {});

  // ══════════════════════════════════════════════════════════════════
  // UTILITIES
  // ══════════════════════════════════════════════════════════════════
  function deepClone(obj) {
    try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return obj; }
  }

  function merge(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
      }
    }
    return target;
  }

  function toNumber(v) {
    return Number(String(v || '0').replace(/[^0-9.]/g, '')) || 0;
  }

  function nowIso() { return new Date().toISOString(); }

  // ══════════════════════════════════════════════════════════════════
  // COMMAND TYPES  (unchanged from v2 — HTML files use these constants)
  // ══════════════════════════════════════════════════════════════════
  var CommandTypes = {
    UPDATE_PROFILE:            'UPDATE_PROFILE',
    UPDATE_CONTACT:            'UPDATE_CONTACT',
    UPDATE_EMPLOYMENT:         'UPDATE_EMPLOYMENT',
    UPDATE_AFFORDABILITY:      'UPDATE_AFFORDABILITY',
    UPDATE_PAYMENT_METHODS:    'UPDATE_PAYMENT_METHODS',
    RECALCULATE_LOAN:          'RECALCULATE_LOAN',
    RECORD_PAYMENT:            'RECORD_PAYMENT',
    APPLY_PAYMENT_HOLIDAY:     'APPLY_PAYMENT_HOLIDAY',
    APPLY_PAYMENT_ARRANGEMENT: 'APPLY_PAYMENT_ARRANGEMENT',
    CHANGE_ACCOUNT_STATUS:     'CHANGE_ACCOUNT_STATUS',
    CHANGE_PAY_DATE:           'CHANGE_PAY_DATE',
    EXTEND_TERM:               'EXTEND_TERM',
    WAIVE_INTEREST:            'WAIVE_INTEREST',
    ADD_OPS_NOTE:              'ADD_OPS_NOTE',
    ADD_CONTACT_ATTEMPT:       'ADD_CONTACT_ATTEMPT',
    FLAG_COLLECTIONS:          'FLAG_COLLECTIONS',
    CLOSE_ACCOUNT:             'CLOSE_ACCOUNT',
    LOG_EVENT:                 'LOG_EVENT'
  };

  // ══════════════════════════════════════════════════════════════════
  // V3 SCHEMA FACTORIES
  // ══════════════════════════════════════════════════════════════════

  function createEmptyLoan(loanId) {
    var now = nowIso();
    return {
      loanId:         loanId || '',
      originatedAt:   now,
      closedAt:       null,
      settlementDate: null,
      closureReason:  null,

      statusEngineState: {
        coreStatus:      'active',
        overlays:        {},
        displayStatus:   'active',
        reasonCodes:     [],
        derivedFlags:    {},
        lastEvaluatedAt: now
      },

      loanCore: {
        principal:  0,
        apr:        0,
        termMonths: 0,
        startDate:  '',
        paidCount:  0
      },

      scheduleSnapshot: [],
      loanSummary: {
        emi: 0, totalRepayable: 0, totalInterest: 0,
        outstandingBalance: 0, totalRepaid: 0, instalmentsRemaining: 0
      },

      transactions: [],

      arrangements: {
        paymentHoliday:          null,
        paymentArrangement:      null,
        paymentHolidayHistory:   [],
        paymentArrangementHistory: []
      },

      forbearanceCases: [],

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

      auditTrail: []
    };
  }

  // Current migration version — increment each time a new migrateAccountWithSeed
  // migration step is added.  loadLegacy compares a stored account's migrationVersion
  // against this constant to decide whether migrations need to run.
  var CURRENT_MIGRATION_VERSION = 3;

  function createEmptyCustomerAccount() {
    var now = nowIso();
    return {
      schemaVersion:    3,
      migrationVersion: CURRENT_MIGRATION_VERSION,   // mark fresh accounts as up-to-date
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
              expRent: 0, expCouncil: 0, expUtilities: 0,
              expFood: 0, expTransport: 0, expChildcare: 0, expMobile: 0,
              expLoans: 0, expCards: 0, expBnpl: 0, expInsurance: 0, expSubs: 0
            }
          },
          derived: { totalIncome: 0, totalExpenditure: 0, disposableIncome: 0 },
          snapshots: []
        }
      },

      activeLoanId:      '',
      loans:             [],
      customerAuditTrail: []
    };
  }

  // Backward-compat alias used by existing HTML code
  function createEmptyAccount() { return createEmptyCustomerAccount(); }

  // ══════════════════════════════════════════════════════════════════
  // DERIVED AFFORDABILITY
  // ══════════════════════════════════════════════════════════════════
  function recalcAffordabilityDerived(account) {
    var raw  = account.affordability.incomeExpenditure.raw;
    var exp  = (raw.housingCosts || 0) + (raw.transportCosts || 0) +
               (raw.livingCosts  || 0) + (raw.otherDebts     || 0);
    account.affordability.incomeExpenditure.derived = {
      totalIncome:      raw.monthlyIncome || 0,
      totalExpenditure: exp,
      disposableIncome: (raw.monthlyIncome || 0) - exp
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // ACCOUNT MIGRATION
  // Run once per stored account when its migrationVersion is behind
  // CURRENT_MIGRATION_VERSION.  Idempotent: re-running produces the same
  // result.  loadLegacy saves the result back to storage automatically.
  // ══════════════════════════════════════════════════════════════════

  /**
   * Ensure every canonical sub-object exists on the account, filling gaps
   * with empty defaults.  Safe to call on any v3 account — never overwrites
   * data that is already present.
   */
  function ensureCanonicalStructure(account) {
    var empty = createEmptyCustomerAccount();
    if (!account.paymentDetails) account.paymentDetails = empty.paymentDetails;
    if (!account.paymentDetails.card) account.paymentDetails.card = empty.paymentDetails.card;
    if (!account.paymentDetails.bank) account.paymentDetails.bank = empty.paymentDetails.bank;
    if (!account.profile) account.profile = empty.profile;
    if (!account.profile.personal)   account.profile.personal   = empty.profile.personal;
    if (!account.profile.employment) account.profile.employment = empty.profile.employment;
    if (!account.profile.contact)    account.profile.contact    = empty.profile.contact;
    if (!account.affordability) account.affordability = empty.affordability;
    if (!account.affordability.incomeExpenditure) account.affordability.incomeExpenditure = empty.affordability.incomeExpenditure;
    if (!account.affordability.incomeExpenditure.raw)     account.affordability.incomeExpenditure.raw     = empty.affordability.incomeExpenditure.raw;
    if (!account.affordability.incomeExpenditure.derived) account.affordability.incomeExpenditure.derived = empty.affordability.incomeExpenditure.derived;
    if (!account.affordability.incomeExpenditure.snapshots) account.affordability.incomeExpenditure.snapshots = [];
    if (!account.affordability.incomeExpenditure.raw.granular) account.affordability.incomeExpenditure.raw.granular = empty.affordability.incomeExpenditure.raw.granular;
    if (!account.customerAuditTrail) account.customerAuditTrail = [];
  }

  /**
   * Apply all pending schema migrations to an existing stored account.
   *
   * Each numbered block runs only when account.migrationVersion < that number,
   * so migrations are additive and idempotent.  The seed is used purely as a
   * source of default values for fields that were never populated; it never
   * overwrites data the user has already saved.
   *
   * After all migrations the account's migrationVersion is set to
   * CURRENT_MIGRATION_VERSION and the caller is responsible for persisting it.
   *
   * @param {Object} account — v3 customerAccount loaded from storage
   * @param {Object} seed    — CUSTOMER_REGISTRY entry (may be undefined)
   * @returns {Object} the same account object, mutated in-place
   */
  function migrateAccountWithSeed(account, seed) {
    var current = account.migrationVersion || 0;
    if (current >= CURRENT_MIGRATION_VERSION) return account;

    // Always guarantee canonical structure before any field-level migration.
    ensureCanonicalStructure(account);

    // ── Migration 1 ──────────────────────────────────────────────────
    // Backfill fields that were absent in earlier builds:
    //   • paymentDetails.card / bank   — seed mapping was missing pre-remediation
    //   • affordability raw fields     — guard against zero-filled old accounts
    //   • profile sub-sections         — guard against missing contact/employment
    if (current < 1) {
      if (seed) {
        var spd = seed.paymentDetails || {};

        // paymentDetails.card — backfill only if the stored value looks like an
        // unset default (no last4 digit recorded = never set by user or seed).
        if (!account.paymentDetails.card.last4 && spd.card && spd.card.last4) {
          merge(account.paymentDetails.card, spd.card);
        }

        // paymentDetails.bank — backfill only if accountHolder is still blank.
        if (!account.paymentDetails.bank.accountHolder && spd.bank && spd.bank.accountHolder) {
          merge(account.paymentDetails.bank, spd.bank);
        }

        // affordability — backfill if monthlyIncome is 0 but seed has a value.
        var rawIE = account.affordability.incomeExpenditure.raw;
        var sie   = seed.incomeExpenditure || {};
        if (!rawIE.monthlyIncome && sie.monthlyIncome) {
          rawIE.monthlyIncome  = sie.monthlyIncome;
          rawIE.housingCosts   = sie.housingCosts   || 0;
          rawIE.transportCosts = sie.transportCosts || 0;
          rawIE.livingCosts    = sie.livingCosts    || 0;
          rawIE.otherDebts     = sie.otherDebts     || 0;
        }

        // Profile — backfill contact if email is missing.
        var pcon = account.profile.contact;
        var scon = (seed.profile && seed.profile.contact) || {};
        if (!pcon.email && scon.email) merge(pcon, scon);

        // Profile — backfill employment if employer is missing.
        var pemp = account.profile.employment;
        var semp = (seed.profile && seed.profile.employment) || {};
        if (!pemp.employer && semp.employer) {
          merge(pemp, {
            status:          semp.status          || '',
            employer:        semp.employer         || '',
            jobTitle:        semp.jobTitle         || '',
            employmentStart: semp.employmentStart  || '',
            annualIncome:    toNumber(semp.annualIncome || 0),
            payFrequency:    semp.payFrequency     || '',
            nextPayDate:     semp.nextPayDate      || ''
          });
        }
      }
    }

    // ── Migration 2 ──────────────────────────────────────────────────
    // (placeholder — no-op; kept so version numbering is stable)

    // ── Migration 3 ──────────────────────────────────────────────────
    // Initialise granular I&E sub-object from flat aggregates so the
    // customer portal can display and edit individual line items.
    // Runs for ALL accounts with migrationVersion < 3, including those
    // that were stamped as v2 by createFromSeed before granular existed.
    // Maps: primary income ← monthlyIncome, rent ← housingCosts,
    //       food ← livingCosts, transport ← transportCosts,
    //       cards ← otherDebts.  All other lines default to 0.
    if (current < 3) {
      var rawG = account.affordability.incomeExpenditure.raw;
      if (!rawG.granular || !(rawG.granular.incSalary || rawG.granular.expRent)) {
        rawG.granular = {
          incSalary:    rawG.monthlyIncome  || 0,
          incSecondary: 0, incBenefits: 0, incOther: 0,
          expRent:      rawG.housingCosts   || 0,
          expCouncil:   0, expUtilities: 0,
          expFood:      rawG.livingCosts    || 0,
          expTransport: rawG.transportCosts || 0,
          expChildcare: 0, expMobile: 0,
          expLoans:     0,
          expCards:     rawG.otherDebts     || 0,
          expBnpl:      0, expInsurance: 0, expSubs: 0
        };
      }
    }

    // Always recalculate derived affordability after any migration so totals
    // are consistent even if raw values were just backfilled above.
    recalcAffordabilityDerived(account);

    account.migrationVersion = CURRENT_MIGRATION_VERSION;
    return account;
  }

  // ══════════════════════════════════════════════════════════════════
  // BUILT-IN LOAN ENGINE  (reducing-balance EMI — unchanged from v2)
  // ══════════════════════════════════════════════════════════════════
  function builtInEngineFactory(params) {
    var P         = params.principal  || 0;
    var apr       = params.apr        || 0;
    var n         = params.termMonths || 0;
    var startDate = new Date(params.startDate || Date.now());
    var paid      = params.paidCount  || 0;
    var r         = (apr / 100) / 12;
    var emi       = 0;
    var sched     = [];

    return {
      calc: function () {
        if (n === 0) { emi = 0; sched = []; return; }
        emi = r === 0 ? P / n : P * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
        sched = [];
        var bal = P;
        for (var i = 0; i < n; i++) {
          var interest  = bal * r;
          var principal = (i === n - 1) ? bal : emi - interest;
          bal = Math.max(0, bal - principal);
          var d = new Date(startDate);
          d.setMonth(d.getMonth() + i);
          sched.push({
            n:         i + 1,
            dueDate:   new Date(d),
            emi:       (i === n - 1) ? principal + interest : emi,
            principal: principal,
            interest:  interest,
            balance:   bal,
            status:    i < paid ? 'paid' : i === paid ? 'current' : 'upcoming',
            ph:        false,
            pa:        false
          });
        }
      },
      summary: function () {
        var outstanding = 0, repaid = 0, principalPaid = 0, interestPaid = 0;
        for (var i = 0; i < sched.length; i++) {
          if (sched[i].status === 'paid') {
            repaid        += sched[i].emi;
            principalPaid += sched[i].principal;
            interestPaid  += sched[i].interest;
          } else {
            outstanding += sched[i].principal;
          }
        }
        return {
          emi:                  emi,
          totalRepayable:       emi * n,
          totalInterest:        emi * n - P,
          outstandingBalance:   outstanding,
          totalRepaid:          repaid,
          principalPaid:        principalPaid,
          interestPaid:         interestPaid,
          instalmentsRemaining: Math.max(0, n - paid)
        };
      },
      nextInstalment: function () {
        for (var i = 0; i < sched.length; i++) {
          if (sched[i].status === 'current' || sched[i].status === 'upcoming') return sched[i];
        }
        return null;
      },
      schedule: function () { return sched; }
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // LOAN SERVICE  (thin wrapper — kept for backward compat)
  // ══════════════════════════════════════════════════════════════════
  function LoanService(options) {
    this.engineFactory = (options && options.engineFactory) || builtInEngineFactory;
  }

  LoanService.prototype.buildSnapshotForLoan = function (loan) {
    var lc = loan.loanCore;
    var engine = this.engineFactory({
      principal:  lc.principal,
      apr:        lc.apr,
      termMonths: lc.termMonths,
      startDate:  lc.startDate,
      paidCount:  lc.paidCount || 0
    });
    engine.calc();
    var summary = engine.summary();
    return merge({}, summary, {
      nextInstalment: engine.nextInstalment(),
      schedule:       engine.schedule()
    });
  };

  // ══════════════════════════════════════════════════════════════════
  // MIGRATIONS
  // ══════════════════════════════════════════════════════════════════

  /**
   * Migrate a v2 canonical account (single loan.contract / loan.servicing)
   * into the v3 multi-loan schema.
   */
  function migrateV2toV3(v2) {
    var now  = nowIso();
    var lc   = (v2.loan && v2.loan.contract)  || {};
    var svc  = (v2.loan && v2.loan.servicing) || {};
    var snap = (v2.loan && v2.loan.snapshot)  || {};
    var docs = v2.documents                   || {};
    var id   = v2.identity                   || {};
    var emp  = v2.employment                 || {};
    var con  = v2.contact                    || {};
    var aff  = v2.affordability              || {};
    var pm   = v2.paymentMethods             || {};
    var ops  = v2.ops                        || {};

    var account = createEmptyCustomerAccount();
    account.schemaVersion = 3;
    account.customerId    = v2.accountId   || v2.storageKey || '';
    account.storageKey    = v2.storageKey  || '';
    account.version       = 1;
    account.updatedAt     = (v2.audit && v2.audit.updatedAt) || now;

    account.profile.personal = {
      title:       id.title       || '',
      firstName:   id.firstName   || '',
      lastName:    id.lastName    || '',
      dob:         (v2.personal && v2.personal.dob) || '',
      initials:    id.initials    || '',
      memberSince: id.memberSince || ''
    };
    account.profile.employment = {
      status:          emp.status          || '',
      employer:        emp.employer        || '',
      jobTitle:        emp.jobTitle        || '',
      employmentStart: emp.employmentStart || '',
      annualIncome:    emp.annualIncome    || 0,
      payFrequency:    emp.payFrequency    || '',
      nextPayDate:     emp.nextPayDate     || ''
    };
    account.profile.contact = {
      email:        con.email        || '',
      phone:        con.phone        || '',
      address:      con.address      || '',
      residentSince: con.residentSince || ''
    };

    account.paymentDetails = {
      card: merge({}, { type:'', last4:'', expiry:'', collectionDayOfMonth:null, active:false }, pm.card || {}),
      bank: merge({}, { accountHolder:'', bankName:'', sortCodeMasked:'', accountNumberMasked:'', fundedToDate:'' }, pm.bank || {})
    };

    account.affordability.incomeExpenditure.raw = {
      monthlyIncome:  aff.monthlyIncome  || 0,
      housingCosts:   aff.housingCosts   || 0,
      transportCosts: aff.transportCosts || 0,
      livingCosts:    aff.livingCosts    || 0,
      otherDebts:     aff.otherDebts     || 0
    };
    recalcAffordabilityDerived(account);

    // Build the loan record
    var loanId = id.loanId || v2.accountId || 'loan-1';
    var loan   = createEmptyLoan(loanId);
    loan.originatedAt  = (v2.audit && v2.audit.createdAt) || now;
    loan.loanCore      = {
      principal:  lc.principal  || 0,
      apr:        lc.apr        || 0,
      termMonths: lc.termMonths || 0,
      startDate:  lc.startDate  || '',
      paidCount:  svc.paidCount || 0
    };
    // Preserve any pre-built snapshot from v2
    if (snap.schedule && snap.schedule.length) {
      loan.scheduleSnapshot = snap.schedule.map(function (r) {
        return {
          n:         r.n,
          dueDate:   r.dueDate instanceof Date ? r.dueDate.toISOString() : r.dueDate,
          emi:       r.emi, principal: r.principal, interest: r.interest,
          balance:   r.balance, status: r.status, ph: r.ph||false, pa: r.pa||false
        };
      });
      loan.loanSummary = {
        emi:                  snap.emi                  || 0,
        totalRepayable:       snap.totalRepayable        || 0,
        totalInterest:        snap.totalInterest         || 0,
        outstandingBalance:   snap.outstandingBalance    || 0,
        totalRepaid:          snap.totalRepaid           || 0,
        instalmentsRemaining: snap.instalmentsRemaining  || 0
      };
    }

    // Servicing overlays
    if (svc.arrangementActive) {
      loan.arrangements.paymentArrangement = {
        active: true, amount: svc.arrangementAmount || 0,
        months: svc.arrangementMonths || 0
      };
    }
    if (svc.paymentHolidayCount && svc.paymentHolidayCount > 0) {
      loan.arrangements.paymentHolidayHistory =
        new Array(svc.paymentHolidayCount).fill({ migratedFromV2: true });
    }

    // Adjustments
    if (svc.termExtensions && svc.termExtensions > 0) {
      loan.adjustments.termExtensions.push({ migratedFromV2: true, count: svc.termExtensions });
    }

    // Documents
    loan.documents = [
      { type: 'secci',               issuedAt: docs.secci               && docs.secci.issuedAt               || loan.originatedAt },
      { type: 'adequateExplanation', issuedAt: docs.adequateExplanation  && docs.adequateExplanation.issuedAt  || loan.originatedAt },
      { type: 'cancellationNotice',  issuedAt: docs.cancellationNotice   && docs.cancellationNotice.issuedAt   || loan.originatedAt },
      { type: 'agreement',           signedAt: docs.agreement            && docs.agreement.signedAt            || loan.originatedAt }
    ];

    // Ops data
    loan.ops = {
      notes:             Array.isArray(ops.notes)      ? ops.notes      : [],
      contactLog:        Array.isArray(ops.contactLog)  ? ops.contactLog  : [],
      collectionsFlagged: !!ops.collectionsFlagged
    };

    // Audit trail from v2 events
    loan.auditTrail = (Array.isArray(v2.events) ? v2.events : []).map(function (e) {
      return {
        id:        e.id        || ('evt-' + Date.now()),
        action:    e.type      || 'unknown',
        payload:   e.payload   || {},
        source:    e.actor     || 'system',
        timestamp: e.timestamp || now
      };
    });

    // Status engine state (use whatever was stored or active seed)
    loan.statusEngineState.coreStatus    = svc.accountStatus || 'active';
    loan.statusEngineState.displayStatus = svc.accountStatus || 'active';
    if (svc.accountStatus === 'closed' || svc.accountStatus === 'terminated') {
      loan.closedAt      = account.updatedAt;
      loan.closureReason = svc.accountStatus;
    }

    account.loans        = [loan];
    account.activeLoanId = loanId;
    // customerAuditTrail is for customer-level events only (profile changes, logins).
    // Loan-level events (payments, status changes, ops actions) live on loan.auditTrail.

    return account;
  }

  /**
   * Migrate a legacy v1 flat-profile account (oldest schema).
   * seed: CUSTOMER_REGISTRY entry.
   */
  function migrateFromLegacy(raw, seed) {
    if (!raw) return null;
    var p   = raw.profile           || {};
    var ie  = raw.incomeExpenditure || {};
    var ov  = raw.loanOverrides     || {};
    var s   = seed                  || {};
    var sp  = s.profile             || {};
    var sl  = s.loan                || {};
    var now = nowIso();

    var account = createEmptyCustomerAccount();
    account.schemaVersion = 3;
    account.customerId    = raw.id   || s.id   || '';
    account.storageKey    = s.storageKey || raw.storageKey || '';
    account.version       = 1;

    account.profile.personal = {
      title:       p.title       || sp.title     || '',
      firstName:   p.firstName   || sp.firstName || (raw.name || '').split(' ')[0] || '',
      lastName:    p.lastName    || sp.lastName  || (raw.name || '').split(' ').slice(1).join(' ') || '',
      dob:         p.dob         || sp.dob       || '',
      initials:    s.initials    || ((p.firstName || '').charAt(0) + (p.lastName || '').charAt(0)).toUpperCase() || '',
      memberSince: s.memberSince || raw.createdAt || ''
    };
    account.profile.employment = {
      status:          p.employmentStatus || sp.employmentStatus || '',
      employer:        p.employer         || sp.employer         || '',
      jobTitle:        p.jobTitle         || sp.jobTitle         || '',
      employmentStart: p.employmentStart  || sp.employmentStart  || '',
      annualIncome:    toNumber(p.annualIncome  || sp.annualIncome  || 0),
      payFrequency:    p.payFrequency     || sp.payFrequency     || '',
      nextPayDate:     p.nextPayDate      || sp.nextPayDate      || ''
    };
    account.profile.contact = {
      email:        p.email         || sp.email        || '',
      phone:        p.phone         || sp.phone        || '',
      address:      p.address       || sp.address      || '',
      residentSince: p.residentSince || sp.residentSince || ''
    };

    account.paymentDetails = {
      card: {
        type:                 p['pd-cardtype']   || '',
        last4:                p['pd-cardlast']   || '',
        expiry:               p['pd-cardexp']    || '',
        collectionDayOfMonth: parseInt(p['pd-collection']) || null,
        active:               !!(p['pd-cardlast'])
      },
      bank: {
        accountHolder:        p['pd-accholder'] || '',
        bankName:             p['pd-bankname']  || '',
        sortCodeMasked:       p['pd-sort']      || '',
        accountNumberMasked:  p['pd-accnum']    || '',
        fundedToDate:         sl.startDate      || ''
      }
    };

    account.affordability.incomeExpenditure.raw = {
      monthlyIncome:  ie.monthlyIncome  || (s.incomeExpenditure && s.incomeExpenditure.monthlyIncome)  || 0,
      housingCosts:   ie.housingCosts   || (s.incomeExpenditure && s.incomeExpenditure.housingCosts)   || 0,
      transportCosts: ie.transportCosts || (s.incomeExpenditure && s.incomeExpenditure.transportCosts) || 0,
      livingCosts:    ie.livingCosts    || (s.incomeExpenditure && s.incomeExpenditure.livingCosts)    || 0,
      otherDebts:     ie.otherDebts     || (s.incomeExpenditure && s.incomeExpenditure.otherDebts)     || 0
    };
    recalcAffordabilityDerived(account);

    var loanId = s.loanId || raw.loanId || 'loan-1';
    var loan   = createEmptyLoan(loanId);
    loan.originatedAt = raw.createdAt || now;
    loan.loanCore     = {
      principal:  ov.principal  !== undefined ? ov.principal  : (sl.principal  || 0),
      apr:        ov.apr        !== undefined ? ov.apr        : (sl.apr        || 0),
      termMonths: ov.term       !== undefined ? ov.term       : (sl.term       || 0),
      startDate:  ov.startDate  || sl.startDate || '',
      paidCount:  ov.paidCount  !== undefined ? ov.paidCount : (sl.paidCount || 0)
    };
    loan.documents = [
      { type: 'secci',               issuedAt: raw.createdAt || now },
      { type: 'adequateExplanation', issuedAt: raw.createdAt || now },
      { type: 'cancellationNotice',  issuedAt: raw.createdAt || now },
      { type: 'agreement',           signedAt: raw.createdAt || now }
    ];
    loan.ops = {
      notes:              raw.opsNotes    || [],
      contactLog:         raw.contactLog  || [],
      collectionsFlagged: false
    };
    loan.auditTrail = (raw.history || []).map(function (h) {
      return {
        id:        h.id || ('evt-' + Date.now()),
        action:    h.action   || 'unknown',
        payload:   h.details  || {},
        source:    h.source   || 'unknown',
        timestamp: h.timestamp || now
      };
    });
    loan.statusEngineState.coreStatus    = ov.accountStatus || sl.accountStatus || 'active';
    loan.statusEngineState.displayStatus = ov.accountStatus || sl.accountStatus || 'active';

    account.loans        = [loan];
    account.activeLoanId = loanId;
    return account;
  }

  /**
   * Normalize any raw object to a valid v3 customerAccount.
   * Handles v3 (pass-through), v2 (migrate), v1-flat (migrate), or seed.
   */
  function normalizeAccount(raw, seed) {
    if (!raw) return seed ? migrateAccountWithSeed(migrateFromLegacy({}, seed), seed) : createEmptyCustomerAccount();
    // v3 — run any pending migrations against the stored account, then return.
    // migrateAccountWithSeed is a no-op when migrationVersion === CURRENT_MIGRATION_VERSION.
    if (raw.schemaVersion === 3 && raw.loans) return migrateAccountWithSeed(raw, seed);
    // v2 canonical (has identity + loan.contract)
    if (raw.identity && raw.loan && raw.loan.contract) return migrateAccountWithSeed(migrateV2toV3(raw), seed);
    // v1 flat profile
    if (raw.profile || raw.loanOverrides) return migrateAccountWithSeed(migrateFromLegacy(raw, seed), seed);
    return createEmptyCustomerAccount();
  }

  // ══════════════════════════════════════════════════════════════════
  // REPOSITORY
  // ══════════════════════════════════════════════════════════════════
  function LocalStorageAccountRepository(options) {
    this.storage = (options && options.storage) ||
                   (typeof window !== 'undefined' ? window.localStorage : null);
  }

  LocalStorageAccountRepository.prototype.getByStorageKey = function (key) {
    if (!this.storage) return null;
    try {
      var raw = this.storage.getItem(key);
      return raw ? normalizeAccount(JSON.parse(raw)) : null;
    } catch (e) { return null; }
  };

  LocalStorageAccountRepository.prototype.save = function (account) {
    if (!this.storage) return account;
    try {
      account.updatedAt = nowIso();
      this.storage.setItem(account.storageKey, JSON.stringify(account));
    } catch (e) {}
    return account;
  };

  /** Create a fresh v3 account from a CUSTOMER_REGISTRY seed entry. */
  LocalStorageAccountRepository.prototype.createFromSeed = function (seed) {
    var now  = nowIso();
    var sp   = seed.profile           || {};
    var sie  = seed.incomeExpenditure || {};
    var sl   = seed.loan              || {};

    // Support both flat (legacy) and v3-structured seed profiles.
    // Flat:       seed.profile.firstName, seed.profile.employmentStatus, …
    // Structured: seed.profile.personal.firstName, seed.profile.employment.status, …
    var spp = sp.personal   || sp;
    var spc = sp.contact    || sp;
    var spe = sp.employment || sp;

    var account = createEmptyCustomerAccount();
    account.customerId    = seed.id;
    account.storageKey    = seed.storageKey;
    account.version       = 0;

    account.profile.personal = {
      title: spp.title || '', firstName: spp.firstName || '', lastName: spp.lastName || '',
      dob: spp.dob || '', initials: seed.initials || '', memberSince: seed.memberSince || ''
    };
    account.profile.employment = {
      status: spe.status || spe.employmentStatus || '', employer: spe.employer || '',
      jobTitle: spe.jobTitle || '', employmentStart: spe.employmentStart || '',
      annualIncome: toNumber(spe.annualIncome || 0),
      payFrequency: spe.payFrequency || '', nextPayDate: spe.nextPayDate || ''
    };
    account.profile.contact = {
      email: spc.email || '', phone: spc.phone || '',
      address: spc.address || '', residentSince: spc.residentSince || ''
    };

    account.affordability.incomeExpenditure.raw = {
      monthlyIncome:  sie.monthlyIncome  || 0,
      housingCosts:   sie.housingCosts   || 0,
      transportCosts: sie.transportCosts || 0,
      livingCosts:    sie.livingCosts    || 0,
      otherDebts:     sie.otherDebts     || 0,
      granular: {
        incSalary:    sie.monthlyIncome  || 0,
        incSecondary: 0, incBenefits: 0, incOther: 0,
        expRent:      sie.housingCosts   || 0,
        expCouncil:   0, expUtilities:   0,
        expFood:      sie.livingCosts    || 0,
        expTransport: sie.transportCosts || 0,
        expChildcare: 0, expMobile:      0,
        expLoans:     0,
        expCards:     sie.otherDebts     || 0,
        expBnpl:      0, expInsurance:   0, expSubs: 0
      }
    };
    recalcAffordabilityDerived(account);

    // Map paymentDetails from seed if provided (card + bank).
    // Only applied on first account creation; subsequent loads use persisted state.
    var spd = seed.paymentDetails || {};
    if (spd.card) merge(account.paymentDetails.card, spd.card);
    if (spd.bank) merge(account.paymentDetails.bank, spd.bank);

    var loanId = seed.loanId || 'loan-1';
    var loan   = createEmptyLoan(loanId);
    loan.originatedAt = now;
    loan.loanCore     = {
      principal:  sl.principal  || 0,
      apr:        sl.apr        || 0,
      termMonths: sl.term       || 0,
      startDate:  sl.startDate  || '',
      paidCount:  sl.paidCount  || 0
    };
    loan.documents = [
      { type: 'secci',               issuedAt: now },
      { type: 'adequateExplanation', issuedAt: now },
      { type: 'cancellationNotice',  issuedAt: now },
      { type: 'agreement',           signedAt: now }
    ];
    loan.statusEngineState.coreStatus    = sl.accountStatus || 'active';
    loan.statusEngineState.displayStatus = sl.accountStatus || 'active';

    account.loans           = [loan];
    account.activeLoanId    = loanId;
    // Fresh account — mark as fully migrated so loadLegacy never re-runs migrations.
    account.migrationVersion = CURRENT_MIGRATION_VERSION;

    return this.save(account);
  };

  // ══════════════════════════════════════════════════════════════════
  // SYNC BUS  (unchanged from v2)
  // ══════════════════════════════════════════════════════════════════
  function BroadcastSyncBus(channelName) {
    this.channelName = channelName || 'proto_sync_v2';
    try {
      this.channel = (typeof BroadcastChannel !== 'undefined')
        ? new BroadcastChannel(this.channelName) : null;
    } catch (e) { this.channel = null; }
  }

  BroadcastSyncBus.prototype.publish = function (event) {
    if (this.channel) { try { this.channel.postMessage(event); } catch (e) {} }
  };

  BroadcastSyncBus.prototype.subscribe = function (handler) {
    if (!this.channel) return function () {};
    var wrapped = function (e) { handler(e.data); };
    this.channel.addEventListener('message', wrapped);
    var ch = this.channel;
    return function () { ch.removeEventListener('message', wrapped); };
  };

  // ══════════════════════════════════════════════════════════════════
  // EVENT UTILITIES
  // ══════════════════════════════════════════════════════════════════

  /** Convert a loan's auditTrail to the legacy history format. */
  function eventsToHistory(events) {
    return (events || []).map(function (e) {
      return {
        id:        e.id,
        action:    e.action || e.type,
        details:   e.payload || e.details || {},
        source:    e.source  || e.actor   || 'system',
        timestamp: e.timestamp
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // ACCOUNT STORE
  // ══════════════════════════════════════════════════════════════════
  function createAccountStore(options) {
    var repository  = options.repository;
    var syncBus     = options.syncBus;
    var state       = null;
    var listeners   = [];
    var ASR         = null; // resolved lazily after engine files are ready

    function getASR() {
      if (!ASR) ASR = NovaPay.accountStateResolver;
      return ASR;
    }

    function activeLoan() {
      if (!state) return null;
      var loans = state.loans || [];
      for (var i = 0; i < loans.length; i++) {
        if (loans[i].loanId === state.activeLoanId) return loans[i];
      }
      return loans[0] || null;
    }

    function emit() {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](state); } catch (e) {}
      }
    }

    function persistAndBroadcast(type, actor) {
      // Rebuild snapshot + run status engine on active loan
      var loan = activeLoan();
      if (loan) {
        var asr = getASR();
        if (asr) {
          asr.rebuildLoanSnapshot(loan);
          asr.runStatusEngine(loan);
        }
      }
      state.version  = (state.version || 0) + 1;
      state.updatedAt = nowIso();
      repository.save(state);
      syncBus.publish({
        storageKey: state.storageKey,
        customerId: state.customerId,
        version:    state.version,
        type:       type,
        actor:      actor,
        timestamp:  state.updatedAt
      });
      emit();
    }

    var store = {

      /** Load v3 account; creates from seed if not found. */
      load: function (storageKey, seed) {
        state = repository.getByStorageKey(storageKey);
        if (!state) {
          state = seed ? repository.createFromSeed(seed)
                       : createEmptyCustomerAccount();
          if (!seed) state.storageKey = storageKey;
        }
        var loan = activeLoan();
        var asr  = getASR();
        if (loan && asr) { asr.rebuildLoanSnapshot(loan); asr.runStatusEngine(loan); }
        repository.save(state);
        emit();
        return state;
      },

      /**
       * Detect schema version and migrate automatically.
       * Use this during the transition period when old localStorage data may exist.
       */
      loadLegacy: function (storageKey, seed) {
        var raw = null;
        try {
          var str = (repository.storage || window.localStorage).getItem(storageKey);
          raw = str ? JSON.parse(str) : null;
        } catch (e) {}

        if (!raw) {
          state = seed ? repository.createFromSeed(seed) : createEmptyCustomerAccount();
          if (!seed) state.storageKey = storageKey;
        } else {
          state = normalizeAccount(raw, seed);
          if (!state.storageKey) state.storageKey = storageKey;
        }

        var loan = activeLoan();
        var asr  = getASR();
        if (loan && asr) {
          if (!loan.scheduleSnapshot || !loan.scheduleSnapshot.length) {
            asr.rebuildLoanSnapshot(loan);
          }
          asr.runStatusEngine(loan);
        }
        repository.save(state);
        emit();
        return state;
      },

      /** Reload from storage (used after sync events). */
      reload: function () {
        if (!state || !state.storageKey) return state;
        var fresh = repository.getByStorageKey(state.storageKey);
        if (fresh) { state = fresh; emit(); }
        return state;
      },

      getState:    function () { return state; },
      getActiveLoan: function () { return activeLoan(); },

      subscribe: function (listener) {
        listeners.push(listener);
        return function () {
          var idx = listeners.indexOf(listener);
          if (idx > -1) listeners.splice(idx, 1);
        };
      },

      dispatch: function (command) {
        if (!state) throw new Error('Store not loaded — call store.load() first');
        var type    = command.type;
        var payload = command.payload || {};
        var actor   = command.actor   || 'system';
        var loan    = activeLoan();

        switch (type) {

          // ── Customer-level mutations ────────────────────────────
          case CommandTypes.UPDATE_PROFILE:
            // 'personal' is the canonical key; 'identity' is the legacy alias kept
            // for backward compatibility with older client dispatches.
            var personalFields = payload.personal || payload.identity;
            if (personalFields) merge(state.profile.personal, personalFields);
            if (payload.contact) merge(state.profile.contact, payload.contact);
            persistAndBroadcast(type, actor);
            break;

          case CommandTypes.UPDATE_CONTACT:
            merge(state.profile.contact, payload);
            persistAndBroadcast(type, actor);
            break;

          case CommandTypes.UPDATE_EMPLOYMENT:
            merge(state.profile.employment, payload);
            persistAndBroadcast(type, actor);
            break;

          case CommandTypes.UPDATE_AFFORDABILITY:
            merge(state.affordability.incomeExpenditure.raw, payload);
            recalcAffordabilityDerived(state);
            persistAndBroadcast(type, actor);
            break;

          case CommandTypes.UPDATE_PAYMENT_METHODS:
            if (payload.card) merge(state.paymentDetails.card, payload.card);
            if (payload.bank) merge(state.paymentDetails.bank, payload.bank);
            persistAndBroadcast(type, actor);
            break;

          // ── Loan-level mutations ────────────────────────────────
          case CommandTypes.RECALCULATE_LOAN:
            if (loan) {
              if (payload.contract)  merge(loan.loanCore, payload.contract);
              if (payload.servicing) {
                if (payload.servicing.paidCount  !== undefined) loan.loanCore.paidCount  = payload.servicing.paidCount;
                if (payload.servicing.accountStatus)            loan.statusEngineState.coreStatus = payload.servicing.accountStatus;
              }
              if (payload.principal  !== undefined) loan.loanCore.principal  = payload.principal;
              if (payload.apr        !== undefined) loan.loanCore.apr        = payload.apr;
              if (payload.termMonths !== undefined) loan.loanCore.termMonths = payload.termMonths;
              if (payload.paidCount  !== undefined) loan.loanCore.paidCount  = payload.paidCount;
              if (payload.startDate)                loan.loanCore.startDate  = payload.startDate;
            }
            persistAndBroadcast(type, actor);
            break;

          case CommandTypes.RECORD_PAYMENT:
            if (loan) {
              if (payload.paidCount !== undefined) {
                loan.loanCore.paidCount = payload.paidCount;
              } else {
                loan.loanCore.paidCount = (loan.loanCore.paidCount || 0) + 1;
              }
              loan.transactions.push({
                id:         'pmt-' + Date.now(),
                type:       'payment',
                amount:     payload.amount || 0,
                date:       payload.date   || nowIso(),
                successful: true,
                actor:      actor
              });
            }
            persistAndBroadcast(type, actor);
            break;

          case CommandTypes.APPLY_PAYMENT_HOLIDAY:
            if (loan) {
              var arrs = loan.arrangements;
              // Archive any existing active PH
              if (arrs.paymentHoliday && arrs.paymentHoliday.active) {
                if (!Array.isArray(arrs.paymentHolidayHistory)) arrs.paymentHolidayHistory = [];
                arrs.paymentHolidayHistory.push(arrs.paymentHoliday);
              }
              var phSnap    = loan.scheduleSnapshot || [];
              var phPaidIdx = loan.loanCore.paidCount || 0;
              var phTarget  = phSnap[phPaidIdx];
              var phLc      = loan.loanCore;

              if (phTarget) {
                // Mark target row as a PH instalment (no payment due)
                var phSavedEmi     = phTarget.emi || 0;
                phTarget.ph        = true;
                phTarget.status    = 'paid';
                phTarget.emi       = 0;
                phTarget.principal = 0;
                phTarget.interest  = 0;
                // balance carries forward unchanged (interest accrues on next row)

                // Extend loan: append a new amortising row at the end
                var phLastRow  = phSnap[phSnap.length - 1];
                var phPrevBal  = phLastRow ? (phLastRow.balance || 0) : 0;
                var phR        = ((phLc.apr || 0) / 100) / 12;
                var phNewInt   = +(phPrevBal * phR).toFixed(2);
                var phNewPrinc = +Math.min(Math.max(0, phSavedEmi - phNewInt), phPrevBal).toFixed(2);
                var phNewBal   = +Math.max(0, phPrevBal - phNewPrinc).toFixed(2);
                var phNewN     = phLastRow ? phLastRow.n + 1 : (phLc.termMonths || 0) + 1;
                var phNewDue;
                try {
                  var _phLD = new Date(phLastRow ? phLastRow.dueDate : nowIso());
                  _phLD.setMonth(_phLD.getMonth() + 1);
                  phNewDue = _phLD.toISOString();
                } catch (e) { phNewDue = nowIso(); }
                phSnap.push({
                  n: phNewN, dueDate: phNewDue,
                  emi: +phSavedEmi.toFixed(2), principal: phNewPrinc,
                  interest: phNewInt, balance: phNewBal,
                  status: 'upcoming', ph: false, pa: false
                });
                phLc.termMonths = (phLc.termMonths || 0) + 1;
              } else {
                // No snapshot row — minimal fallback: extend term only
                phLc.termMonths = (phLc.termMonths || 0) + 1;
              }
              phLc.paidCount = phPaidIdx + 1;

              // Re-sync row status labels
              for (var _pi = 0; _pi < phSnap.length; _pi++) {
                if (phSnap[_pi].status === 'paid') continue;
                phSnap[_pi].status = _pi < phLc.paidCount ? 'paid'
                  : _pi === phLc.paidCount ? 'current' : 'upcoming';
              }

              arrs.paymentHoliday = {
                active:      true,
                startDate:   payload.startDate || (phTarget && phTarget.dueDate) || nowIso(),
                endDate:     payload.endDate   || (phTarget && phTarget.dueDate) || null,
                instalmentN: phPaidIdx + 1,
                reason:      payload.reason || ''
              };
            }
            persistAndBroadcast(type, actor);
            break;

          case CommandTypes.APPLY_PAYMENT_ARRANGEMENT:
            if (loan) {
              var arrsPA = loan.arrangements;
              // Archive existing active PA
              if (arrsPA.paymentArrangement && arrsPA.paymentArrangement.active) {
                if (!Array.isArray(arrsPA.paymentArrangementHistory)) arrsPA.paymentArrangementHistory = [];
                arrsPA.paymentArrangementHistory.push(arrsPA.paymentArrangement);
              }
              // Supersede active PH: a PA takes precedence
              if (arrsPA.paymentHoliday && arrsPA.paymentHoliday.active) {
                arrsPA.paymentHoliday.active = false;
                if (!Array.isArray(arrsPA.paymentHolidayHistory)) arrsPA.paymentHolidayHistory = [];
                arrsPA.paymentHolidayHistory.push(arrsPA.paymentHoliday);
                arrsPA.paymentHoliday = null;
              }
              var paLc      = loan.loanCore;
              var paSnap    = loan.scheduleSnapshot || [];
              var paPaidIdx = paLc.paidCount || 0;
              var paOutstanding = payload.outstandingBalance ||
                                  (loan.loanSummary && loan.loanSummary.outstandingBalance) || 0;
              var paAmount  = payload.amount || 0;
              var paMonths  = payload.months || (paAmount > 0 ? Math.ceil(paOutstanding / paAmount) : 0);
              arrsPA.paymentArrangement = {
                active:      true,
                amount:      paAmount,
                months:      paMonths,
                startDate:   payload.startDate || nowIso(),
                endDate:     payload.endDate   || null,
                totalAmount: payload.totalAmount || +(paAmount * paMonths).toFixed(2),
                totalPaid:   0,
                broken:      false
              };
              // Tag upcoming rows as PA-covered so UIs can style them
              for (var _pai = paPaidIdx; _pai < paSnap.length && _pai < paPaidIdx + paMonths; _pai++) {
                paSnap[_pai].pa = true;
              }
            }
            persistAndBroadcast(type, actor);
            break;

          case CommandTypes.CHANGE_ACCOUNT_STATUS:
            if (loan) {
              var newSt = payload.status || 'active';
              loan.statusEngineState.coreStatus    = newSt;
              loan.statusEngineState.displayStatus = newSt;
              loan.adjustments.statusChanges.push({
                from: (loan.statusEngineState.coreStatus), to: newSt,
                timestamp: nowIso(), actor: actor
              });
            }
            persistAndBroadcast(type, actor);
            break;

          case CommandTypes.CHANGE_PAY_DATE:
            if (loan) {
              if (payload.day) loan.loanCore.payDay = payload.day;
              if (payload.contract && payload.contract.startDate) {
                loan.loanCore.startDate = payload.contract.startDate;
              }
              loan.adjustments.dueDateChanges.push({
                newDay: payload.day, timestamp: nowIso(), actor: actor
              });
            }
            persistAndBroadcast(type, actor);
            break;

          case CommandTypes.EXTEND_TERM:
            if (loan) {
              var extra = payload.extraMonths || 0;
              loan.loanCore.termMonths = (loan.loanCore.termMonths || 0) + extra;
              loan.adjustments.termExtensions.push({
                extraMonths: extra, newTerm: loan.loanCore.termMonths,
                timestamp: nowIso(), actor: actor
              });
            }
            persistAndBroadcast(type, actor);
            break;

          case CommandTypes.WAIVE_INTEREST:
            if (loan) {
              var waiveAmt = payload.amount || 0;
              loan.adjustments.interestWaivers.push({
                amount: waiveAmt, timestamp: nowIso(), actor: actor
              });
              // Reduce outstanding principal proxy via loanCore
              loan.loanCore.principal = Math.max(0, (loan.loanCore.principal || 0) - waiveAmt);
            }
            persistAndBroadcast(type, actor);
            break;

          case CommandTypes.ADD_OPS_NOTE:
            if (loan) {
              loan.ops.notes.push({
                text:      payload.text || '',
                agent:     actor,
                timestamp: nowIso()
              });
            }
            persistAndBroadcast(type, actor);
            break;

          case CommandTypes.ADD_CONTACT_ATTEMPT:
            if (loan) {
              loan.ops.contactLog.push(merge({}, payload, { agent: actor, timestamp: nowIso() }));
            }
            persistAndBroadcast(type, actor);
            break;

          case CommandTypes.FLAG_COLLECTIONS:
            if (loan) loan.ops.collectionsFlagged = true;
            persistAndBroadcast(type, actor);
            break;

          case CommandTypes.CLOSE_ACCOUNT:
            if (loan) {
              loan.statusEngineState.coreStatus    = 'terminated';
              loan.statusEngineState.displayStatus = 'terminated';
              loan.closedAt      = nowIso();
              loan.closureReason = 'terminated';
              loan.adjustments.statusChanges.push({
                from: 'active', to: 'terminated', timestamp: loan.closedAt, actor: actor
              });
            }
            persistAndBroadcast(type, actor);
            break;

          case CommandTypes.LOG_EVENT:
            // Pure audit — no loan mutation, no schedule rebuild
            if (loan) {
              loan.auditTrail.push({
                id:        (payload.action || 'evt') + '-' + Date.now(),
                action:    payload.action || 'event',
                payload:   payload.details || {},
                source:    actor,
                timestamp: nowIso()
              });
            }
            state.version   = (state.version || 0) + 1;
            state.updatedAt = nowIso();
            repository.save(state);
            syncBus.publish({
              storageKey: state.storageKey,
              customerId: state.customerId,
              version:    state.version,
              type:       payload.action || type,
              actor:      actor,
              timestamp:  state.updatedAt
            });
            emit();
            break;

          default:
            if (loan) {
              loan.auditTrail.push({
                id: type + '-' + Date.now(), action: type,
                payload: payload, source: actor, timestamp: nowIso()
              });
            }
            repository.save(state);
            emit();
        }
      }
    };

    return store;
  }

  // ══════════════════════════════════════════════════════════════════
  // SELECTORS — project v3 state to view models
  // Output shapes are identical to v2 so all existing render code works.
  // ══════════════════════════════════════════════════════════════════
  var selectors = {

    _activeLoan: function (state) {
      var loans = state.loans || [];
      for (var i = 0; i < loans.length; i++) {
        if (loans[i].loanId === state.activeLoanId) return loans[i];
      }
      return loans[0] || null;
    },

    selectFullName: function (state) {
      var p = state.profile.personal;
      return ((p.firstName || '') + ' ' + (p.lastName || '')).trim() || '';
    },

    selectProfile: function (state) {
      var p   = state.profile;
      var per = p.personal;
      var emp = p.employment;
      var con = p.contact;
      var raw = state.affordability.incomeExpenditure.raw;
      var drv = state.affordability.incomeExpenditure.derived;
      return {
        title:            per.title,
        firstName:        per.firstName,
        lastName:         per.lastName,
        fullName:         selectors.selectFullName(state),
        initials:         per.initials,
        loanId:           selectors._activeLoan(state) && selectors._activeLoan(state).loanId || '',
        memberSince:      per.memberSince,
        dob:              per.dob,
        email:            con.email,
        phone:            con.phone,
        address:          con.address,
        residentSince:    con.residentSince,
        employmentStatus: emp.status,
        employer:         emp.employer,
        jobTitle:         emp.jobTitle,
        employmentStart:  emp.employmentStart,
        annualIncome:     emp.annualIncome,
        payFrequency:     emp.payFrequency,
        nextPayDate:      emp.nextPayDate,
        monthlyIncome:    raw.monthlyIncome,
        housingCosts:     raw.housingCosts,
        transportCosts:   raw.transportCosts,
        livingCosts:      raw.livingCosts,
        otherDebts:       raw.otherDebts,
        disposableIncome: drv.disposableIncome
      };
    },

    selectDashboard: function (state) {
      var loan = selectors._activeLoan(state);
      if (!loan) return {};
      var lc   = loan.loanCore    || {};
      var sum  = loan.loanSummary || {};
      var se   = loan.statusEngineState || {};
      var snap = loan.scheduleSnapshot  || [];
      // Find next instalment from snapshot
      var next = null;
      for (var i = lc.paidCount || 0; i < snap.length; i++) {
        if (snap[i].status !== 'paid') { next = snap[i]; break; }
      }
      return {
        accountStatus:        se.coreStatus    || 'active',
        displayStatus:        se.displayStatus || 'active',
        principal:            lc.principal,
        apr:                  lc.apr,
        termMonths:           lc.termMonths,
        paidCount:            lc.paidCount,
        emi:                  sum.emi,
        totalRepayable:       sum.totalRepayable,
        totalInterest:        sum.totalInterest,
        outstandingBalance:   sum.outstandingBalance,
        totalRepaid:          sum.totalRepaid,
        instalmentsRemaining: sum.instalmentsRemaining,
        nextInstalment:       next,
        schedule:             snap
      };
    },

    selectPaymentDetails: function (state) {
      var c = state.paymentDetails.card;
      var b = state.paymentDetails.bank;
      return {
        card: {
          type:          c.type  || '',
          maskedNumber:  c.last4 ? 'XXXX  XXXX  XXXX  ' + c.last4 : '',
          last4:         c.last4 || '',
          expiry:        c.expiry || '',
          collectionDay: c.collectionDayOfMonth,
          active:        c.active
        },
        bank: {
          accountHolder: b.accountHolder       || '',
          bankName:      b.bankName            || '',
          sortCode:      b.sortCodeMasked      || '',
          accountNumber: b.accountNumberMasked || '',
          fundedToDate:  b.fundedToDate        || ''
        }
      };
    },

    selectStatement: function (state) {
      var loan = selectors._activeLoan(state);
      if (!loan) return {};
      var lc   = loan.loanCore    || {};
      var sum  = loan.loanSummary || {};
      return {
        principal:            lc.principal,
        apr:                  lc.apr,
        termMonths:           lc.termMonths,
        startDate:            lc.startDate,
        paidCount:            lc.paidCount,
        emi:                  sum.emi,
        totalRepayable:       sum.totalRepayable,
        totalInterest:        sum.totalInterest,
        outstandingBalance:   sum.outstandingBalance,
        totalRepaid:          sum.totalRepaid,
        instalmentsRemaining: sum.instalmentsRemaining,
        schedule:             loan.scheduleSnapshot || []
      };
    },

    selectDocuments: function (state) {
      var loan = selectors._activeLoan(state);
      if (!loan) return {};
      var lc   = loan.loanCore    || {};
      var sum  = loan.loanSummary || {};
      var se   = loan.statusEngineState || {};
      var docs = {};
      (loan.documents || []).forEach(function (d) { docs[d.type] = d; });
      return {
        borrowerName:    selectors.selectFullName(state),
        borrowerAddress: state.profile.contact.address,
        loanId:          loan.loanId,
        loan: {
          principal: lc.principal, apr: lc.apr, termMonths: lc.termMonths,
          startDate: lc.startDate, emi: sum.emi, totalRepayable: sum.totalRepayable
        },
        docs: {
          secci:               { issuedAt: (docs.secci               && docs.secci.issuedAt)              || '' },
          adequateExplanation: { issuedAt: (docs.adequateExplanation  && docs.adequateExplanation.issuedAt) || '' },
          cancellationNotice:  { issuedAt: (docs.cancellationNotice   && docs.cancellationNotice.issuedAt)  || '' },
          agreement:           { signedAt: (docs.agreement            && docs.agreement.signedAt)           || '' }
        },
        accountStatus: se.coreStatus || 'active',
        createdAt:     loan.originatedAt
      };
    },

    selectOpsCustomer: function (state) {
      var loan = selectors._activeLoan(state);
      var per  = state.profile.personal;
      var emp  = state.profile.employment;
      var con  = state.profile.contact;
      var raw  = state.affordability.incomeExpenditure.raw;
      var drv  = state.affordability.incomeExpenditure.derived;
      var se   = (loan && loan.statusEngineState) || {};
      var ops  = (loan && loan.ops) || {};
      return {
        customerId:        state.customerId,
        loanId:            loan && loan.loanId || '',
        title:             per.title,
        firstName:         per.firstName,
        lastName:          per.lastName,
        fullName:          selectors.selectFullName(state),
        initials:          per.initials,
        memberSince:       per.memberSince,
        email:             con.email,
        phone:             con.phone,
        address:           con.address,
        residentSince:     con.residentSince,
        dob:               per.dob,
        employmentStatus:  emp.status,
        employer:          emp.employer,
        jobTitle:          emp.jobTitle,
        employmentStart:   emp.employmentStart,
        annualIncome:      emp.annualIncome,
        payFrequency:      emp.payFrequency,
        nextPayDate:       emp.nextPayDate,
        monthlyIncome:     raw.monthlyIncome,
        housingCosts:      raw.housingCosts,
        transportCosts:    raw.transportCosts,
        livingCosts:       raw.livingCosts,
        otherDebts:        raw.otherDebts,
        disposableIncome:  drv.disposableIncome,
        accountStatus:     se.coreStatus    || 'active',
        displayStatus:     se.displayStatus || 'active',
        overlays:          se.overlays      || {},
        opsNotes:          ops.notes        || [],
        contactLog:        ops.contactLog   || [],
        collectionsFlagged: !!(ops.collectionsFlagged),
        createdAt:         loan && loan.originatedAt || '',
        updatedAt:         state.updatedAt
      };
    },

    selectCollections: function (state) {
      var loan = selectors._activeLoan(state);
      var se   = (loan && loan.statusEngineState) || {};
      var sum  = (loan && loan.loanSummary) || {};
      var ops  = (loan && loan.ops) || {};
      var snap = (loan && loan.scheduleSnapshot) || [];
      var lc   = (loan && loan.loanCore) || {};
      var next = snap[lc.paidCount || 0] || null;
      var dpd  = 0;
      if (next && se.coreStatus !== 'active') {
        dpd = Math.max(0, Math.floor((Date.now() - new Date(next.dueDate).getTime()) / 86400000));
      }
      return {
        accountStatus:      se.coreStatus         || 'active',
        displayStatus:      se.displayStatus       || 'active',
        outstandingBalance: sum.outstandingBalance || 0,
        daysPastDue:        dpd,
        collectionsFlagged: !!(ops.collectionsFlagged),
        contactLog:         ops.contactLog         || []
      };
    },

    /** Return all loans (active + historical) as a summary list. */
    selectLoanHistory: function (state) {
      return (state.loans || []).map(function (l) {
        var se  = l.statusEngineState || {};
        var lc  = l.loanCore          || {};
        var sum = l.loanSummary       || {};
        return {
          loanId:          l.loanId,
          originatedAt:    l.originatedAt,
          closedAt:        l.closedAt,
          coreStatus:      se.coreStatus    || 'active',
          displayStatus:   se.displayStatus || 'active',
          principal:       lc.principal,
          apr:             lc.apr,
          termMonths:      lc.termMonths,
          totalRepaid:     sum.totalRepaid || 0,
          outstandingBalance: sum.outstandingBalance || 0,
          isActive:        l.loanId === state.activeLoanId
        };
      });
    }
  };

  // ══════════════════════════════════════════════════════════════════
  // FORMATTERS  (unchanged from v2)
  // ══════════════════════════════════════════════════════════════════
  var formatters = {
    fmt: function (n) { return '\u00a3' + (n || 0).toFixed(2); },
    fmtCurrency: function (n) {
      return '\u00a3' + (n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },
    fmtDate: function (d) {
      if (!d) return '';
      var mn = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      var dt = new Date(d);
      return dt.getDate() + ' ' + mn[dt.getMonth()] + ' ' + dt.getFullYear();
    },
    shortDate: function (d) {
      if (!d) return '';
      var dt = new Date(d);
      var mn = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return ('0'+dt.getDate()).slice(-2) + ' ' + mn[dt.getMonth()] + ' ' + dt.getFullYear();
    },
    fmtDob: function (iso) {
      if (!iso) return '';
      var mn = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      var d  = new Date(iso);
      return isNaN(d) ? iso : d.getDate() + ' ' + mn[d.getMonth()] + ' ' + d.getFullYear();
    },
    fmtTs: function (iso) {
      if (!iso) return '';
      var d   = new Date(iso);
      var now = new Date();
      var diff = (now - d) / 1000;
      if (diff < 60)    return 'Just now';
      if (diff < 3600)  return Math.floor(diff / 60)   + 'm ago';
      if (diff < 86400) return Math.floor(diff / 3600)  + 'h ago';
      return d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'2-digit' });
    },
    fmtIncome: function (n) {
      if (!n) return '';
      var num = Number(String(n).replace(/[^0-9.]/g, '')) || 0;
      return '\u00a3' + num.toLocaleString();
    }
  };

  // ══════════════════════════════════════════════════════════════════
  // MERGE INTO window.NovaPay
  // ══════════════════════════════════════════════════════════════════
  merge(NovaPay, {
    version:                    '3.0.0',
    CommandTypes:               CommandTypes,

    // Schema factories
    createEmptyCustomerAccount: createEmptyCustomerAccount,
    createEmptyAccount:         createEmptyAccount,   // backward compat alias
    createEmptyLoan:            createEmptyLoan,

    // Migrations & normalisation
    normalizeAccount:             normalizeAccount,
    migrateAccountWithSeed:       migrateAccountWithSeed,
    ensureCanonicalStructure:     ensureCanonicalStructure,
    CURRENT_MIGRATION_VERSION:    CURRENT_MIGRATION_VERSION,
    migrateV2toV3:                migrateV2toV3,
    migrateFromLegacy:            migrateFromLegacy,

    // Event utilities
    eventsToHistory:            eventsToHistory,

    // Infrastructure
    LocalStorageAccountRepository: LocalStorageAccountRepository,
    BroadcastSyncBus:           BroadcastSyncBus,
    builtInEngineFactory:       builtInEngineFactory,
    LoanService:                LoanService,
    createAccountStore:         createAccountStore,

    // View projections
    selectors:                  selectors,
    formatters:                 formatters
  });

})(typeof window !== 'undefined' ? window : this);
