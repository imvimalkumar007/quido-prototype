/**
 * Quido Account State Resolver — v3.0
 * Central mutation paths for all account and loan changes.
 * Every state-changing operation flows through commitCustomerMutation or
 * commitLoanMutation — never direct property writes from application code.
 *
 * Depends on: status-engine-config.js, loan-status-engine.js,
 *             servicing-policy-engine.js
 *
 * After every loan mutation the resolver:
 *   1. Applies the caller's mutation function
 *   2. Rebuilds the schedule snapshot from loanCore params
 *      (skipped when the caller supplies a pre-built snapshot)
 *   3. Runs the status engine → updates statusEngineState
 *   4. Checks for loan closure (settled / closed)
 *   5. Appends to the loan auditTrail
 *   6. Increments the account version and appends to customerAuditTrail
 */
;(function (global) {
  'use strict';

  var Quido = global.Quido || (global.Quido = {});

  // ── Internal helpers ─────────────────────────────────────────────

  function _now() { return new Date(); }

  function _ts(d) { return (d || _now()).toISOString(); }

  function _findLoan(account, loanId) {
    var loans = account.loans || [];
    for (var i = 0; i < loans.length; i++) {
      if (loans[i].loanId === loanId) return loans[i];
    }
    return null;
  }

  function _activeLoan(account) {
    return _findLoan(account, account.activeLoanId) ||
           ((account.loans && account.loans[0]) || null);
  }

  function _appendLoanAudit(loan, source, action, payload) {
    if (!Array.isArray(loan.auditTrail)) loan.auditTrail = [];
    loan.auditTrail.push({
      id:        action + '-' + Date.now(),
      action:    action,
      payload:   payload || {},
      source:    source  || 'system',
      timestamp: _ts()
    });
  }

  function _appendCustomerAudit(account, source, action, payload) {
    if (!Array.isArray(account.customerAuditTrail)) account.customerAuditTrail = [];
    var now = _ts();
    account.customerAuditTrail.push({
      id:        action + '-' + Date.now(),
      action:    action,
      payload:   payload || {},
      source:    source  || 'system',
      timestamp: now
    });
    account.updatedAt = now;
    account.version   = (account.version || 0) + 1;
  }

  // ── Schedule rebuild ─────────────────────────────────────────────

  /**
   * Rebuild scheduleSnapshot and loanSummary from loanCore parameters.
   * Uses Quido.builtInEngineFactory (defined in quido-core.js).
   * Skips rebuild when opts.skipRebuild === true (caller supplies snapshot).
   */
  function rebuildLoanSnapshot(loan, opts) {
    if (opts && opts.skipRebuild) return;
    var lc = loan.loanCore;
    if (!lc || !lc.principal || !lc.termMonths) return;

    var engine = Quido.builtInEngineFactory({
      principal:  lc.principal,
      apr:        lc.apr        || 0,
      termMonths: lc.termMonths,
      startDate:  lc.startDate  || new Date().toISOString(),
      paidCount:  lc.paidCount  || 0
    });
    engine.calc();
    var summary           = engine.summary();
    loan.scheduleSnapshot = engine.schedule().map(function (r) {
      return {
        n:         r.n,
        dueDate:   r.dueDate instanceof Date ? r.dueDate.toISOString() : r.dueDate,
        emi:       r.emi,
        principal: r.principal,
        interest:  r.interest,
        balance:   r.balance,
        status:    r.status,
        ph:        r.ph || false,
        pa:        r.pa || false
      };
    });
    loan.loanSummary = {
      emi:                  summary.emi,
      totalRepayable:       summary.totalRepayable,
      totalInterest:        summary.totalInterest,
      outstandingBalance:   summary.outstandingBalance,
      totalRepaid:          summary.totalRepaid,
      instalmentsRemaining: summary.instalmentsRemaining
    };
  }

  // ── Status engine runner ─────────────────────────────────────────

  /**
   * Run the full status + overlay evaluation for a single loan and
   * update its statusEngineState in place.
   * @param {Object} loan
   * @param {Date}   [now]
   * @returns {Object} updated statusEngineState
   */
  function runStatusEngine(loan, now) {
    now = now || _now();
    var seResult = Quido.loanStatusEngine.evaluateCoreStatus(loan, now);
    var overlays = Quido.servicingPolicyEngine.evaluateOverlays(loan, seResult.coreStatus, now);
    var display  = Quido.servicingPolicyEngine.resolveDisplayStatus(seResult.coreStatus, overlays);

    // Derive 4-field model values from the evaluated overlays
    var _SC = Quido.StatusConfig;
    var _fovType = (loan.forbearanceOverlay && loan.forbearanceOverlay.active)
                    ? loan.forbearanceOverlay.type : null;
    var _svcOv = null, _svcSub = null;
    if (!_fovType) {
      if (overlays.paymentArrangement) {
        _svcOv = 'payment_arrangement';
        var _paType = overlays.paymentArrangement.type;
        if (_paType === _SC.OV.PA_COMPLETED) _svcSub = 'completed';
        else if (_paType === _SC.OV.PA_BROKEN) _svcSub = 'broken';
        else _svcSub = 'on_track';
      } else if (overlays.paymentHoliday && overlays.paymentHoliday.type === _SC.OV.PH_ACTIVE) {
        _svcOv = 'payment_holiday';
      }
    }
    var _resolvedDisplay = _fovType
      || (_svcOv === 'payment_holiday' ? 'payment_holiday'
      : (_svcOv === 'payment_arrangement' && _svcSub !== 'broken' && _svcSub !== 'completed'
          ? 'payment_arrangement'
          : seResult.coreStatus));

    loan.statusEngineState = {
      // 4-field model (used by Forbearance tab and new renders)
      baseStatus:            seResult.coreStatus,
      servicingOverlay:      _svcOv,
      servicingSubStatus:    _svcSub,
      forbearanceOverlay:    _fovType,
      resolvedDisplayStatus: _resolvedDisplay,
      // Legacy fields (used by existing renders throughout the app)
      coreStatus:      seResult.coreStatus,
      overlays:        overlays,
      displayStatus:   display,
      reasonCodes:     seResult.reasonCodes   || [],
      derivedFlags:    seResult.derivedFlags  || {},
      lastEvaluatedAt: _ts(now)
    };

    // Mark loan closed/settled if engine says so
    var SC = Quido.StatusConfig;
    var cs = seResult.coreStatus;
    if ((cs === SC.CS.CLOSED || cs === SC.CS.SETTLED) && !loan.closedAt) {
      loan.closedAt      = _ts(now);
      loan.closureReason = cs;
      if (cs === SC.CS.SETTLED) loan.settlementDate = _ts(now);
    }

    return loan.statusEngineState;
  }

  // ── Allowed / blocked actions ────────────────────────────────────

  var TERMINAL_STATUSES   = ['settled', 'closed'];
  var PA_BLOCKED_STATUSES = ['settled', 'closed'];

  /**
   * Build the operative schedule from a loan's snapshot.
   * Guarantees every row has ph/pa defaults — same rows the UIs render.
   *
   * @param {Object} loan
   * @returns {Object[]}
   */
  function buildOperativeSchedule(loan) {
    var snap = loan.scheduleSnapshot || [];
    return snap.map(function (row) {
      return {
        n:         row.n,
        dueDate:   row.dueDate,
        emi:       row.emi       || 0,
        principal: row.principal || 0,
        interest:  row.interest  || 0,
        balance:   row.balance   || 0,
        status:    row.status    || 'upcoming',
        ph:        row.ph        || false,
        pa:        row.pa        || false
      };
    });
  }

  /**
   * Derive which servicing actions are currently permitted or blocked.
   * Mirrors backend/domain/status-engine.js:deriveAllowedActions.
   * Uses the shared PH/PA eligibility engines already loaded on the page.
   *
   * @param {Object} loan
   * @param {string} coreStatus
   * @param {Object} overlays
   * @param {Object} derivedFlags
   * @param {Date}   [now]
   * @returns {{ allowedActions: string[], blockedActions: string[], reasons: Object }}
   */
  function deriveAllowedActions(loan, coreStatus, overlays, derivedFlags, now) {
    now = now || _now();
    var allowed = [];
    var blocked = [];
    var reasons = {};
    var pe      = Quido.servicingPolicyEngine;

    // Payments
    if (TERMINAL_STATUSES.indexOf(coreStatus) === -1) {
      allowed.push('record_payment');
      allowed.push('record_partial_payment');
      allowed.push('record_manual_payment');
    } else {
      blocked.push('record_payment');
      blocked.push('record_partial_payment');
      blocked.push('record_manual_payment');
      reasons['record_payment'] = 'Account is ' + coreStatus + '.';
    }

    // Payment Holiday
    var phElig = pe.checkPHEligibility(loan, coreStatus, derivedFlags, now);
    if (phElig.eligible) {
      allowed.push('apply_payment_holiday');
    } else {
      blocked.push('apply_payment_holiday');
      reasons['apply_payment_holiday'] = phElig.reason;
    }

    // Payment Arrangement
    var paElig = pe.checkPAEligibility(loan, coreStatus);
    if (paElig.eligible) {
      allowed.push('apply_payment_arrangement');
    } else {
      blocked.push('apply_payment_arrangement');
      reasons['apply_payment_arrangement'] = paElig.reason;
    }

    // Ops-only mutations
    if (TERMINAL_STATUSES.indexOf(coreStatus) === -1) {
      allowed.push('change_account_status');
      allowed.push('add_ops_note');
      allowed.push('add_contact_attempt');
      allowed.push('waive_interest');
      allowed.push('extend_term');
      allowed.push('change_pay_date');
      allowed.push('flag_collections');
      allowed.push('close_account');
    } else {
      blocked.push('change_account_status');
      blocked.push('waive_interest');
      blocked.push('extend_term');
      blocked.push('change_pay_date');
      blocked.push('close_account');
      reasons['change_account_status'] = 'Account is ' + coreStatus + '.';
    }

    return { allowedActions: allowed, blockedActions: blocked, reasons: reasons };
  }

  // ── Public mutation paths ────────────────────────────────────────

  /**
   * Commit a customer-level mutation (profile, payment details, affordability).
   *
   * @param {Object}   account   - v3 customerAccount (mutated in place)
   * @param {string}   source    - 'customer_ui' | 'ops_ui' | 'system'
   * @param {string}   action    - descriptive action name for audit
   * @param {Function} mutateFn  - function(account) — apply changes in here
   * @param {Object}   [opts]    - { payload } extra data for audit entry
   * @returns {Object} account
   */
  function commitCustomerMutation(account, source, action, mutateFn, opts) {
    mutateFn(account);
    _appendCustomerAudit(account, source, action, (opts && opts.payload) || {});
    return account;
  }

  /**
   * Commit a loan-level mutation.
   * After mutateFn runs: schedule rebuilt → status engine → audit appended.
   *
   * @param {Object}   account   - v3 customerAccount (mutated in place)
   * @param {string}   loanId    - target loan; falls back to activeLoanId
   * @param {string}   source    - 'customer_ui' | 'ops_ui' | 'system'
   * @param {string}   action    - descriptive action name for audit
   * @param {Function} mutateFn  - function(loan) — apply changes here
   * @param {Object}   [opts]    - { payload, skipRebuild, now }
   * @returns {Object} account
   */
  function commitLoanMutation(account, loanId, source, action, mutateFn, opts) {
    var loan = loanId ? _findLoan(account, loanId) : _activeLoan(account);
    if (!loan) return account;

    mutateFn(loan);
    rebuildLoanSnapshot(loan, opts);
    runStatusEngine(loan, opts && opts.now);
    _appendLoanAudit(loan, source, action, (opts && opts.payload) || {});
    _appendCustomerAudit(account, source, action, (opts && opts.payload) || {});
    return account;
  }

  // ── Public API ───────────────────────────────────────────────────
  Quido.accountStateResolver = {
    commitCustomerMutation: commitCustomerMutation,
    commitLoanMutation:     commitLoanMutation,
    rebuildLoanSnapshot:    rebuildLoanSnapshot,
    runStatusEngine:        runStatusEngine,
    deriveAllowedActions:   deriveAllowedActions,
    buildOperativeSchedule: buildOperativeSchedule,
    findLoan:               _findLoan,
    getActiveLoan:          _activeLoan
  };

})(typeof window !== 'undefined' ? window : this);
