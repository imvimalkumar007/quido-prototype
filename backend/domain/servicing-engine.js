/**
 * Quido Servicing Engine — Node.js
 *
 * Central mutation engine for all loan servicing operations.
 *
 * Every mutation follows the same five-step flow:
 *   1. Validate eligibility (via status-engine checks)
 *   2. Apply the state change to the loan object
 *   3. Sync schedule row statuses and rebuild loanSummary
 *   4. Run status engine to recompute coreStatus / overlays
 *   5. Append an audit trail entry
 *
 * All functions return { ok: boolean, loan: Object, error?: string }.
 * The caller (AccountService) is responsible for persisting the mutated loan.
 *
 * Pure functions — no side-effects outside the passed loan object.
 * No global state.
 */
'use strict';

const { computeOutstandingBalance } = require('./loan-engine');
const {
  CS,
  FOV,
  FOV_PRIORITY,
  BALANCE_TOLERANCE,
  evaluateCoreStatus,
  evaluateOverlays,
  checkPHEligibility,
  checkPAEligibility,
  checkForbearanceEligibility,
  runStatusEngine
} = require('./status-engine');
const { ENTRY_TYPES, postEntry } = require('./ledger-engine');

// ── Audit helpers ─────────────────────────────────────────────────────────────

function _auditEntry(action, payload, actor, timestamp) {
  return {
    id:        'se-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    action:    action,
    payload:   payload || {},
    source:    actor || 'servicing_engine',
    timestamp: timestamp || new Date().toISOString()
  };
}

function _pushAudit(loan, action, payload, actor, ts) {
  if (!Array.isArray(loan.auditTrail)) loan.auditTrail = [];
  loan.auditTrail.push(_auditEntry(action, payload, actor, ts));
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function _addMonths(date, n) {
  var d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

function _capAmount(value) {
  return +Math.max(0, value || 0).toFixed(2);
}

function _ensureRowTracking(row) {
  if (!row) return;
  row.interestPaid  = _capAmount(row.interestPaid);
  row.principalPaid = _capAmount(row.principalPaid);
  if (row.status === 'paid') {
    row.interestPaid  = _capAmount(Math.max(row.interestPaid, row.interest || 0));
    row.principalPaid = _capAmount(Math.max(row.principalPaid, row.principal || 0));
  }
}

function _interestRemaining(row) {
  _ensureRowTracking(row);
  return _capAmount((row.interest || 0) - (row.interestPaid || 0));
}

function _principalRemaining(row) {
  _ensureRowTracking(row);
  return _capAmount((row.principal || 0) - (row.principalPaid || 0));
}

function _rowRemaining(row) {
  return _capAmount(_interestRemaining(row) + _principalRemaining(row));
}

function _recomputePaidCount(loan) {
  var snap = loan.scheduleSnapshot || [];
  var idx = 0;
  for (; idx < snap.length; idx++) {
    var row = snap[idx];
    _ensureRowTracking(row);
    if (row.ph) {
      row.status = 'paid';
      continue;
    }
    if (_rowRemaining(row) <= BALANCE_TOLERANCE) {
      row.status = 'paid';
      continue;
    }
    break;
  }
  return idx;
}

function _appendTransaction(loan, txn) {
  if (!Array.isArray(loan.transactions)) loan.transactions = [];
  loan.transactions.push(txn);
  return txn;
}

// ── Schedule helpers ──────────────────────────────────────────────────────────

/**
 * Allocate a payment amount against the earliest unpaid schedule rows.
 * PH rows are skipped (they contribute no balance). Any remainder after
 * clearing whole rows is stored as partialCredit on the loan.
 *
 * @param {Object} loan
 * @param {number} amount
 * @returns {number} number of rows fully cleared this call
 */
function allocatePaymentToSchedule(loan, amount) {
  var snap      = loan.scheduleSnapshot || [];
  var paidIdx   = (loan.loanCore && loan.loanCore.paidCount) || 0;
  var remaining = _capAmount(amount);
  var cleared   = 0;
  var interestApplied  = 0;
  var principalApplied = 0;
  var dueSatisfied = false;
  var rowAllocations = [];

  for (var i = paidIdx; i < snap.length; i++) {
    var row = snap[i];
    if (row.status === 'paid') continue;

    // PH rows cost nothing — mark and advance
    if (row.ph) {
      row.status = 'paid';
      cleared++;
      continue;
    }

    _ensureRowTracking(row);

    if (!dueSatisfied) {
      var interestDue = _interestRemaining(row);
      if (interestDue > BALANCE_TOLERANCE && remaining > BALANCE_TOLERANCE) {
        var interestPay = Math.min(remaining, interestDue);
        row.interestPaid = _capAmount((row.interestPaid || 0) + interestPay);
        remaining = _capAmount(remaining - interestPay);
        interestApplied = _capAmount(interestApplied + interestPay);
        rowAllocations.push({ n: row.n, interestApplied: interestPay, principalApplied: 0 });
      }

      var principalDue = _principalRemaining(row);
      if (principalDue > BALANCE_TOLERANCE && remaining > BALANCE_TOLERANCE) {
        var principalPay = Math.min(remaining, principalDue);
        row.principalPaid = _capAmount((row.principalPaid || 0) + principalPay);
        remaining = _capAmount(remaining - principalPay);
        principalApplied = _capAmount(principalApplied + principalPay);
        rowAllocations.push({ n: row.n, interestApplied: 0, principalApplied: principalPay });
      }

      if (_rowRemaining(row) <= BALANCE_TOLERANCE) {
        row.status = 'paid';
        cleared++;
        dueSatisfied = true;
        continue;
      }
      break;
    }

    var prepaidPrincipal = _principalRemaining(row);
    if (prepaidPrincipal > BALANCE_TOLERANCE && remaining > BALANCE_TOLERANCE) {
      var overpay = Math.min(remaining, prepaidPrincipal);
      row.principalPaid = _capAmount((row.principalPaid || 0) + overpay);
      remaining = _capAmount(remaining - overpay);
      principalApplied = _capAmount(principalApplied + overpay);
      rowAllocations.push({ n: row.n, interestApplied: 0, principalApplied: overpay });
    }

    if (_rowRemaining(row) <= BALANCE_TOLERANCE) {
      row.status = 'paid';
    }

    if (remaining <= BALANCE_TOLERANCE) break;
  }

  loan.partialCredit = 0;
  return {
    cleared:          cleared,
    remaining:        remaining,
    interestApplied:  interestApplied,
    principalApplied: principalApplied,
    rowAllocations:   rowAllocations
  };
}

/**
 * Synchronise row status labels after paidCount is updated.
 * Rows before paidIdx → 'paid'
 * Row at paidIdx     → 'current'
 * Rest               → 'upcoming'
 * Already-paid rows are never downgraded.
 */
function syncRowStatuses(loan) {
  var snap    = loan.scheduleSnapshot || [];
  var paidIdx = (loan.loanCore && loan.loanCore.paidCount) || 0;
  for (var i = 0; i < snap.length; i++) {
    _ensureRowTracking(snap[i]);
    if (_rowRemaining(snap[i]) <= BALANCE_TOLERANCE || snap[i].ph) {
      snap[i].status = 'paid';
      continue;
    }
    if (i < paidIdx)        { snap[i].status = 'paid';    continue; }
    if (i === paidIdx)      { snap[i].status = 'current'; continue; }
    snap[i].status = 'upcoming';
  }
}

/**
 * Rebuild loanSummary from the current schedule snapshot and paidCount.
 * Called after any mutation that changes row states.
 */
function rebuildSummary(loan) {
  var snap    = loan.scheduleSnapshot || [];

  // EMI = contractual amount of the first unpaid non-PH row
  var emiAmt = 0;
  for (var j = 0; j < snap.length; j++) {
    if (snap[j].ph) continue;
    if (_rowRemaining(snap[j]) > BALANCE_TOLERANCE) {
      emiAmt = snap[j].emi || 0;
      break;
    }
  }

  var totalRepayable = 0;
  var totalInterest  = 0;
  var totalRepaid    = 0;
  var totalInterestPaid = 0;
  var totalPrincipalPaid = 0;
  var remaining      = 0;

  for (var i = 0; i < snap.length; i++) {
    var row = snap[i];
    if (row.ph) continue; // PH rows contribute nothing to financials
    _ensureRowTracking(row);
    totalRepayable += row.emi || 0;
    totalInterest  += row.interest || 0;
    totalInterestPaid  += row.interestPaid || 0;
    totalPrincipalPaid += row.principalPaid || 0;
    if (_rowRemaining(row) > BALANCE_TOLERANCE) {
      remaining += 1;
    }
  }

  totalInterestPaid  = _capAmount(totalInterestPaid);
  totalPrincipalPaid = _capAmount(totalPrincipalPaid);
  totalRepaid = _capAmount(totalInterestPaid + totalPrincipalPaid);
  var outBal = _capAmount(totalRepayable - totalRepaid);
  if (outBal <= BALANCE_TOLERANCE) remaining = 0;

  loan.loanSummary = {
    emi:                  +emiAmt.toFixed(2),
    totalRepayable:       +totalRepayable.toFixed(2),
    totalInterest:        +totalInterest.toFixed(2),
    outstandingBalance:   +outBal.toFixed(2),
    totalRepaid:          +totalRepaid.toFixed(2),
    totalInterestPaid:    +totalInterestPaid.toFixed(2),
    totalPrincipalPaid:   +totalPrincipalPaid.toFixed(2),
    instalmentsRemaining: remaining
  };
}

// ── Payment mutations ─────────────────────────────────────────────────────────

/**
 * Record a standard (EMI) or partial payment and update the loan state.
 *
 * @param {Object} loan
 * @param {number} amount     — payment amount
 * @param {string} [date]     — ISO date string; defaults to now
 * @param {string} [actor]    — 'customer' | 'ops' | etc.
 * @param {Date}   [now]      — evaluation reference time
 * @returns {{ ok: boolean, loan: Object, error?: string }}
 */
function applyRepayment(loan, amount, date, actor, now) {
  now   = now   || new Date();
  actor = actor || 'customer';
  date  = date  || now.toISOString();

  var seResult = evaluateCoreStatus(loan, now);
  if (seResult.coreStatus === CS.SETTLED || seResult.coreStatus === CS.CLOSED) {
    return { ok: false, loan: loan, error: 'Cannot record payment — account is ' + seResult.coreStatus + '.' };
  }

  var snap    = loan.scheduleSnapshot || [];
  var paidIdx = (loan.loanCore && loan.loanCore.paidCount) || 0;
  var nextRow = snap[paidIdx] || null;
  var emiAmt  = nextRow ? (nextRow.emi || 0) : 0;
  var txnType = amount >= emiAmt - BALANCE_TOLERANCE ? 'payment' : 'partial_payment';

  var txn = _appendTransaction(loan, {
    id:         'pmt-' + Date.now(),
    type:       txnType,
    amount:     amount,
    date:       date,
    successful: true,
    actor:      actor
  });

  var allocation = allocatePaymentToSchedule(loan, amount);
  loan.loanCore.paidCount = _recomputePaidCount(loan);
  syncRowStatuses(loan);
  rebuildSummary(loan);
  runStatusEngine(loan, now);

  // Track against active payment arrangement
  var arrs = loan.arrangements || {};
  if (arrs.paymentArrangement && arrs.paymentArrangement.active) {
    arrs.paymentArrangement.totalPaid = +((arrs.paymentArrangement.totalPaid || 0) + amount).toFixed(2);
  }

  // Ledger
  txn.allocation = {
    interestApplied: allocation.interestApplied,
    principalApplied: allocation.principalApplied,
    rows: allocation.rowAllocations
  };

  postEntry(loan, ENTRY_TYPES.CASH_RECEIVED, amount, date, actor, txn.id);

  _pushAudit(loan, 'repayment_recorded', {
    amount: amount,
    cleared: allocation.cleared,
    txnType: txnType,
    interestApplied: allocation.interestApplied,
    principalApplied: allocation.principalApplied
  }, actor, date);

  return { ok: true, loan: loan };
}

/**
 * Record a manual (ops-initiated or backdated) payment.
 * Identical to applyRepayment but tagged as 'manual_payment'.
 *
 * @param {Object} loan
 * @param {number} amount
 * @param {string} [date]
 * @param {string} [actor]
 * @param {Date}   [now]
 * @returns {{ ok, loan, error? }}
 */
function applyManualPayment(loan, amount, date, actor, now) {
  now   = now   || new Date();
  actor = actor || 'ops';
  date  = date  || now.toISOString();

  var txn = _appendTransaction(loan, {
    id:         'mpmt-' + Date.now(),
    type:       'manual_payment',
    amount:     amount,
    date:       date,
    successful: true,
    actor:      actor
  });

  var paidIdx = (loan.loanCore && loan.loanCore.paidCount) || 0;
  var allocation = allocatePaymentToSchedule(loan, amount);
  loan.loanCore.paidCount = _recomputePaidCount(loan);
  syncRowStatuses(loan);
  rebuildSummary(loan);
  runStatusEngine(loan, now);

  // Track against active payment arrangement
  var arrsM = loan.arrangements || {};
  if (arrsM.paymentArrangement && arrsM.paymentArrangement.active) {
    arrsM.paymentArrangement.totalPaid = +((arrsM.paymentArrangement.totalPaid || 0) + amount).toFixed(2);
  }

  // Ledger
  txn.allocation = {
    interestApplied: allocation.interestApplied,
    principalApplied: allocation.principalApplied,
    rows: allocation.rowAllocations
  };

  postEntry(loan, ENTRY_TYPES.CASH_RECEIVED, amount, date, actor, txn.id);

  _pushAudit(loan, 'manual_payment_recorded', {
    amount: amount,
    cleared: allocation.cleared,
    interestApplied: allocation.interestApplied,
    principalApplied: allocation.principalApplied
  }, actor, date);

  return { ok: true, loan: loan };
}

function refundPayment(loan, txnId, actor, now, reason) {
  now = now || new Date();
  actor = actor || 'ops';
  reason = (reason || '').trim();
  var status = evaluateCoreStatus(loan, now).coreStatus;
  if (status === CS.CLOSED || status === CS.SETTLED || loan.closedAt) {
    return { ok: false, loan: loan, error: 'Refunds are not allowed on a closed or settled loan.' };
  }

  var txns = loan.transactions || [];
  var txn = null;
  for (var i = txns.length - 1; i >= 0; i--) {
    if (txns[i].id === txnId) { txn = txns[i]; break; }
  }
  if (!txn) return { ok: false, loan: loan, error: 'Payment transaction not found.' };
  if (txn.refundedAt || txn.refundTxnId) {
    return { ok: false, loan: loan, error: 'Payment has already been refunded.' };
  }
  if (['payment', 'partial_payment', 'manual_payment'].indexOf(txn.type) === -1) {
    return { ok: false, loan: loan, error: 'Only payment transactions can be refunded.' };
  }
  var allocation = txn.allocation;
  if (!allocation || !Array.isArray(allocation.rows) || !allocation.rows.length) {
    return { ok: false, loan: loan, error: 'This payment cannot be refunded because its allocation details are unavailable.' };
  }

  var snap = loan.scheduleSnapshot || [];
  for (var a = allocation.rows.length - 1; a >= 0; a--) {
    var alloc = allocation.rows[a];
    for (var r = 0; r < snap.length; r++) {
      if (snap[r].n !== alloc.n) continue;
      _ensureRowTracking(snap[r]);
      if (alloc.principalApplied) {
        snap[r].principalPaid = _capAmount((snap[r].principalPaid || 0) - alloc.principalApplied);
      }
      if (alloc.interestApplied) {
        snap[r].interestPaid = _capAmount((snap[r].interestPaid || 0) - alloc.interestApplied);
      }
      break;
    }
  }

  loan.loanCore.paidCount = _recomputePaidCount(loan);
  syncRowStatuses(loan);
  rebuildSummary(loan);
  runStatusEngine(loan, now);

  var refundTxn = _appendTransaction(loan, {
    id:         'rfnd-' + Date.now(),
    type:       'refund',
    amount:     txn.amount,
    date:       now.toISOString(),
    successful: true,
    actor:      actor,
    refundFor:  txn.id,
    reason:     reason
  });
  txn.refundedAt = now.toISOString();
  txn.refundTxnId = refundTxn.id;
  txn.refundReason = reason;

  postEntry(loan, ENTRY_TYPES.REVERSAL, txn.amount, now.toISOString(), actor, txn.id);
  _pushAudit(loan, 'payment_refunded', {
    txnId: txn.id,
    amount: txn.amount,
    refundTxnId: refundTxn.id,
    reason: reason
  }, actor, now.toISOString());

  return { ok: true, loan: loan };
}

// ── Payment Holiday ───────────────────────────────────────────────────────────

/**
 * Apply a payment holiday to the next due instalment.
 *
 * Marks the current row as ph=true (emi zeroed), advances paidCount,
 * extends term by 1 month, appends a new terminal row to the schedule.
 *
 * @param {Object} loan
 * @param {{ reason?: string, startDate?: string }} payload
 * @param {Date}   [now]
 * @param {string} [actor]
 * @returns {{ ok, loan, error? }}
 */
function applyPaymentHoliday(loan, payload, now, actor) {
  now    = now    || new Date();
  actor  = actor  || 'customer';
  payload = payload || {};

  var seResult = evaluateCoreStatus(loan, now);
  var elig     = checkPHEligibility(loan, seResult.coreStatus, seResult.derivedFlags, now, actor === 'ops');
  if (!elig.eligible) {
    return { ok: false, loan: loan, error: elig.reason };
  }

  var snap    = loan.scheduleSnapshot || [];
  var paidIdx = (loan.loanCore && loan.loanCore.paidCount) || 0;
  var target  = snap[paidIdx];

  if (!target) {
    return { ok: false, loan: loan, error: 'No upcoming instalment to apply payment holiday to.' };
  }

  // Archive existing active PH
  var arrs = loan.arrangements;
  if (arrs.paymentHoliday && arrs.paymentHoliday.active) {
    if (!Array.isArray(arrs.paymentHolidayHistory)) arrs.paymentHolidayHistory = [];
    arrs.paymentHolidayHistory.push(Object.assign({}, arrs.paymentHoliday));
  }

  // Mark the target row as a payment holiday instalment
  target.ph      = true;
  target.status  = 'paid'; // treated as handled
  var savedEmi   = target.emi || 0;
  target.emi     = 0;
  target.principal = 0;
  target.interest  = 0;
  // target.balance stays — unpaid principal carries forward

  // Advance paidCount over the PH row
  loan.loanCore.paidCount = paidIdx + 1;

  // Extend term: append a new row at the end of the schedule
  var lc         = loan.loanCore;
  var lastRow    = snap[snap.length - 1];
  var prevBal    = lastRow ? lastRow.balance : 0;
  var newN       = lastRow ? lastRow.n + 1 : (lc.termMonths || 0) + 1;
  var rMonthly   = ((lc.apr || 0) / 100) / 12;
  var newInt     = +(prevBal * rMonthly).toFixed(2);
  var newPrinc   = +Math.min(Math.max(0, savedEmi - newInt), prevBal).toFixed(2);
  var newBal     = +Math.max(0, prevBal - newPrinc).toFixed(2);

  snap.push({
    n:         newN,
    dueDate:   _addMonths(new Date(lastRow ? lastRow.dueDate : now), 1).toISOString(),
    emi:       +savedEmi.toFixed(2),
    principal: newPrinc,
    interest:  newInt,
    balance:   newBal,
    status:    'upcoming',
    ph:        false,
    pa:        false
  });

  lc.termMonths = (lc.termMonths || 0) + 1;

  var startDate = payload.startDate || target.dueDate || now.toISOString();
  var endDate   = target.dueDate    || now.toISOString();

  arrs.paymentHoliday = {
    active:      true,
    startDate:   startDate,
    endDate:     endDate,
    instalmentN: paidIdx + 1, // 1-indexed
    reason:      payload.reason || ''
  };

  syncRowStatuses(loan);
  rebuildSummary(loan);
  runStatusEngine(loan, now);

  _pushAudit(loan, 'payment_holiday_created', {
    instalmentN: paidIdx + 1,
    startDate:   startDate,
    endDate:     endDate,
    reason:      payload.reason || ''
  }, actor, now.toISOString());

  return { ok: true, loan: loan };
}

/**
 * Complete an active payment holiday (admin / scheduled close).
 *
 * @param {Object} loan
 * @param {Date}   [now]
 * @param {string} [actor]
 * @returns {{ ok, loan, error? }}
 */
function completePaymentHoliday(loan, now, actor) {
  now   = now   || new Date();
  actor = actor || 'system';

  var arrs = loan.arrangements;
  if (!arrs.paymentHoliday || !arrs.paymentHoliday.active) {
    return { ok: false, loan: loan, error: 'No active payment holiday to complete.' };
  }

  var ph = Object.assign({}, arrs.paymentHoliday, { active: false });
  if (!Array.isArray(arrs.paymentHolidayHistory)) arrs.paymentHolidayHistory = [];
  arrs.paymentHolidayHistory.push(ph);
  arrs.paymentHoliday = null;

  runStatusEngine(loan, now);

  _pushAudit(loan, 'payment_holiday_completed', {}, actor, now.toISOString());

  return { ok: true, loan: loan };
}

// ── Payment Arrangement ───────────────────────────────────────────────────────

/**
 * Create a payment arrangement on the account.
 *
 * Supersedes any active payment holiday, archives any existing PA,
 * marks upcoming schedule rows with pa=true.
 *
 * @param {Object} loan
 * @param {{
 *   amount: number,
 *   months?: number,
 *   startDate?: string,
 *   endDate?: string,
 *   outstandingBalance?: number,
 *   totalAmount?: number
 * }} payload
 * @param {Date}   [now]
 * @param {string} [actor]
 * @returns {{ ok, loan, error? }}
 */
function applyPaymentArrangement(loan, payload, now, actor) {
  now    = now    || new Date();
  actor  = actor  || 'ops';
  payload = payload || {};

  var seResult = evaluateCoreStatus(loan, now);
  var elig     = checkPAEligibility(loan, seResult.coreStatus);
  if (!elig.eligible) {
    return { ok: false, loan: loan, error: elig.reason };
  }

  var arrs = loan.arrangements;

  // Archive existing PA
  if (arrs.paymentArrangement) {
    if (!Array.isArray(arrs.paymentArrangementHistory)) arrs.paymentArrangementHistory = [];
    arrs.paymentArrangementHistory.push(Object.assign({}, arrs.paymentArrangement));
  }

  // Supersede active PH
  if (arrs.paymentHoliday && arrs.paymentHoliday.active) {
    var supersededPH = Object.assign({}, arrs.paymentHoliday, { active: false, supersededAt: now.toISOString() });
    if (!Array.isArray(arrs.paymentHolidayHistory)) arrs.paymentHolidayHistory = [];
    arrs.paymentHolidayHistory.push(supersededPH);
    arrs.paymentHoliday = null;
  }

  var lc          = loan.loanCore || {};
  var paidIdx     = lc.paidCount || 0;
  var snap        = loan.scheduleSnapshot || [];
  var outstanding = payload.outstandingBalance
    || computeOutstandingBalance(snap, paidIdx, loan.partialCredit || 0);

  var amount    = payload.amount  || 0;
  var months    = payload.months  || (amount > 0 ? Math.ceil(outstanding / amount) : 0);
  var startDate = payload.startDate || now.toISOString();
  var endDate   = payload.endDate   || _addMonths(new Date(startDate), months).toISOString();
  var total     = payload.totalAmount || +(amount * months).toFixed(2);

  // Tag upcoming rows as PA-covered
  for (var i = paidIdx; i < snap.length && i < paidIdx + months; i++) {
    snap[i].pa = true;
  }

  arrs.paymentArrangement = {
    active:      true,
    amount:      amount,
    months:      months,
    startDate:   startDate,
    endDate:     endDate,
    totalAmount: total,
    totalPaid:   0,
    broken:      false
  };

  runStatusEngine(loan, now);

  _pushAudit(loan, 'payment_arrangement_created', {
    amount: amount, months: months, startDate: startDate, endDate: endDate
  }, actor, now.toISOString());

  return { ok: true, loan: loan };
}

/**
 * Mark an active payment arrangement as broken.
 * Clears pa flags from upcoming schedule rows.
 *
 * @param {Object} loan
 * @param {Date}   [now]
 * @param {string} [actor]
 * @returns {{ ok, loan, error? }}
 */
function breakPaymentArrangement(loan, now, actor) {
  now   = now   || new Date();
  actor = actor || 'ops';

  var arrs = loan.arrangements;
  if (!arrs.paymentArrangement || !arrs.paymentArrangement.active) {
    return { ok: false, loan: loan, error: 'No active payment arrangement to break.' };
  }

  arrs.paymentArrangement.active   = false;
  arrs.paymentArrangement.broken   = true;
  arrs.paymentArrangement.brokenAt = now.toISOString();

  // Clear pa flags from remaining unpaid rows
  var snap    = loan.scheduleSnapshot || [];
  var paidIdx = (loan.loanCore && loan.loanCore.paidCount) || 0;
  for (var i = paidIdx; i < snap.length; i++) {
    if (snap[i].pa) snap[i].pa = false;
  }

  runStatusEngine(loan, now);

  _pushAudit(loan, 'payment_arrangement_broken', {
    brokenAt: now.toISOString()
  }, actor, now.toISOString());

  return { ok: true, loan: loan };
}

/**
 * Complete an active payment arrangement (all instalments received).
 *
 * @param {Object} loan
 * @param {Date}   [now]
 * @param {string} [actor]
 * @returns {{ ok, loan, error? }}
 */
function completePaymentArrangement(loan, now, actor) {
  now   = now   || new Date();
  actor = actor || 'system';

  var arrs = loan.arrangements;
  if (!arrs.paymentArrangement || !arrs.paymentArrangement.active) {
    return { ok: false, loan: loan, error: 'No active payment arrangement to complete.' };
  }

  var completed = Object.assign({}, arrs.paymentArrangement, { active: false });
  if (!Array.isArray(arrs.paymentArrangementHistory)) arrs.paymentArrangementHistory = [];
  arrs.paymentArrangementHistory.push(completed);
  arrs.paymentArrangement = null;

  runStatusEngine(loan, now);

  _pushAudit(loan, 'payment_arrangement_completed', {}, actor, now.toISOString());

  return { ok: true, loan: loan };
}

// ── Failed payment ────────────────────────────────────────────────────────────

/**
 * Record a failed payment attempt.
 *
 * Does not advance paidCount or touch the schedule — the loan state is
 * unchanged. Records the attempt in transactions[] and audit trail so
 * ops and the status engine have an accurate payment history.
 *
 * @param {Object} loan
 * @param {number} amount
 * @param {string} [date]
 * @param {string} [actor]
 * @param {string} [reason]  — e.g. 'insufficient_funds', 'card_declined'
 * @param {Date}   [now]
 * @returns {{ ok: boolean, loan: Object }}
 */
function recordFailedPayment(loan, amount, date, actor, reason, now) {
  now    = now    || new Date();
  actor  = actor  || 'customer';
  date   = date   || now.toISOString();
  reason = reason || 'unknown';

  if (!Array.isArray(loan.transactions)) loan.transactions = [];
  loan.transactions.push({
    id:         'fpmt-' + Date.now(),
    type:       'failed_payment',
    amount:     amount,
    date:       date,
    successful: false,
    actor:      actor,
    reason:     reason
  });

  _pushAudit(loan, 'payment_failed', {
    amount: amount, reason: reason
  }, actor, date);

  return { ok: true, loan: loan };
}

// ── Forbearance / insolvency overlays ─────────────────────────────────────────

/**
 * Apply a forbearance or insolvency overlay to the loan.
 *
 * Eligible overlay types: dmp, breathing_space, dro, iva, trust_deed, bankruptcy
 * Blocked when: account is settled/closed, or another forbearance overlay is active.
 *
 * Captures the original status context (base status + active servicing overlay)
 * so exit logic can restore/recalculate correctly.
 *
 * @param {Object} loan
 * @param {string} type    — one of FOV.*
 * @param {{ startDate?, expectedEndDate?, reason? }} payload
 * @param {Date}   [now]
 * @param {string} [actor]
 * @returns {{ ok, loan, error? }}
 */
function applyForbearanceOverlay(loan, type, payload, now, actor) {
  now    = now    || new Date();
  actor  = actor  || 'ops';
  payload = payload || {};

  if (!type || FOV_PRIORITY.indexOf(type) === -1) {
    return { ok: false, loan: loan, error: 'Unknown forbearance overlay type: ' + type + '.' };
  }

  var seResult = evaluateCoreStatus(loan, now);
  var svcState = deriveServicingState(loan, now);
  var elig     = checkForbearanceEligibility(loan, seResult.coreStatus);

  if (!elig.eligible) {
    return { ok: false, loan: loan, error: elig.reason };
  }

  // Capture original context so exit can restore/recalculate correctly
  var originalContext = {
    baseStatus:        seResult.coreStatus,
    reasonCodes:       seResult.reasonCodes || [],
    servicingOverlay:  svcState.servicingOverlay,
    servicingSubStatus: svcState.servicingSubStatus
  };

  loan.forbearanceOverlay = {
    active:          true,
    type:            type,
    startDate:       payload.startDate       || now.toISOString(),
    expectedEndDate: payload.expectedEndDate || null,
    reason:          payload.reason          || '',
    reference:       payload.reference       || '',
    provider:        payload.provider        || '',
    appliedBy:       actor,
    appliedAt:       now.toISOString(),
    originalContext: originalContext,
    exitedAt:        null,
    exitReason:      null,
    outcome:         null
  };

  runStatusEngine(loan, now);

  _pushAudit(loan, 'forbearance_overlay_applied', {
    type:            type,
    startDate:       loan.forbearanceOverlay.startDate,
    expectedEndDate: loan.forbearanceOverlay.expectedEndDate,
    originalContext: originalContext
  }, actor, now.toISOString());

  return { ok: true, loan: loan };
}

/**
 * Exit an active forbearance/insolvency overlay.
 *
 * Outcome values and their effects:
 *   'settled'   — zero outstanding balance → status engine resolves to 'settled'
 *                 (DRO, IVA, Trust Deed, Bankruptcy: successful completion)
 *   'closed'    — zero outstanding balance → status engine resolves to 'closed'
 *                 (DMP: fully paid off)
 *   'terminated'— force coreStatus = terminated; engine keeps it sticky
 *                 (DRO/IVA/Trust Deed/Bankruptcy cancelled or failed)
 *   'pullback'  — clear overlay, restore original context baseline, re-evaluate
 *                 (DMP cancelled/terminated without full payoff)
 *   'restored'  — same as pullback (Breathing Space ended normally)
 *
 * @param {Object} loan
 * @param {string} outcome  — 'settled' | 'closed' | 'terminated' | 'pullback' | 'restored'
 * @param {{ reason? }} payload
 * @param {Date}   [now]
 * @param {string} [actor]
 * @returns {{ ok, loan, error? }}
 */
function exitForbearanceOverlay(loan, outcome, payload, now, actor) {
  now    = now    || new Date();
  actor  = actor  || 'ops';
  payload = payload || {};

  if (!loan.forbearanceOverlay || !loan.forbearanceOverlay.active) {
    return { ok: false, loan: loan, error: 'No active forbearance overlay to exit.' };
  }

  var validOutcomes = ['settled', 'closed', 'terminated', 'pullback', 'restored'];
  if (validOutcomes.indexOf(outcome) === -1) {
    return { ok: false, loan: loan, error: 'Unknown exit outcome: ' + outcome + '. Must be one of: ' + validOutcomes.join(', ') + '.' };
  }

  var fov      = loan.forbearanceOverlay;
  var fovType  = fov.type;
  var exitedAt = now.toISOString();
  var orig     = fov.originalContext || {};

  // Archive the overlay — move to forbearanceCases history
  var archived = Object.assign({}, fov, {
    active:     false,
    exitedAt:   exitedAt,
    exitReason: payload.reason || outcome,
    outcome:    outcome
  });
  if (!Array.isArray(loan.forbearanceCases)) loan.forbearanceCases = [];
  loan.forbearanceCases.push(archived);
  loan.forbearanceOverlay = null;

  // Apply outcome-specific state changes before running the status engine
  switch (outcome) {

    case 'settled':
      // DRO, IVA, Trust Deed, Bankruptcy — successful completion.
      // Zero the schedule balance, seed engine with terminated so balance-cleared branch → settled.
      var snapSt = loan.scheduleSnapshot || [];
      for (var si = 0; si < snapSt.length; si++) {
        if (snapSt[si].status !== 'paid') snapSt[si].status = 'paid';
      }
      loan.loanCore.paidCount = snapSt.length;
      loan.partialCredit      = 0;
      if (loan.statusEngineState) loan.statusEngineState.baseStatus = CS.TERMINATED;
      break;

    case 'closed':
      // DMP fully paid off — zero balance, seed with active so balance-cleared branch → closed.
      var snapCl = loan.scheduleSnapshot || [];
      for (var ci = 0; ci < snapCl.length; ci++) {
        if (snapCl[ci].status !== 'paid') snapCl[ci].status = 'paid';
      }
      loan.loanCore.paidCount = snapCl.length;
      loan.partialCredit      = 0;
      if (loan.statusEngineState) loan.statusEngineState.baseStatus = CS.ACTIVE;
      break;

    case 'terminated':
      // Cancelled/failed overlay (DRO/IVA/Trust Deed/Bankruptcy) → Terminated.
      // Engine Rule 2 keeps terminated sticky while balance remains.
      if (loan.statusEngineState) loan.statusEngineState.baseStatus = CS.TERMINATED;
      break;

    case 'pullback':
    case 'restored':
      // DMP cancelled / Breathing Space ended — restore original baseline, re-evaluate fresh.
      if (loan.statusEngineState) {
        loan.statusEngineState.baseStatus = orig.baseStatus || CS.ACTIVE;
      }
      break;
  }

  rebuildSummary(loan);
  runStatusEngine(loan, now);

  _pushAudit(loan, 'forbearance_overlay_exited', {
    type:      fovType,
    outcome:   outcome,
    exitedAt:  exitedAt,
    reason:    payload.reason || outcome
  }, actor, exitedAt);

  return { ok: true, loan: loan };
}

// ── Settlement ────────────────────────────────────────────────────────────────

/**
 * Trigger a settlement evaluation — useful after ops adjustments
 * (interest waivers, balance reductions) that may bring the loan to zero
 * outside a normal payment flow.
 *
 * @param {Object} loan
 * @param {Date}   [now]
 * @param {string} [actor]
 * @returns {{ ok, loan, settled: boolean }}
 */
function triggerSettlementEvaluation(loan, now, actor) {
  now   = now   || new Date();
  actor = actor || 'system';

  rebuildSummary(loan);
  runStatusEngine(loan, now);

  var cs      = loan.statusEngineState.baseStatus;
  var settled = cs === CS.SETTLED || cs === CS.CLOSED;

  _pushAudit(loan, 'settlement_evaluation', {
    coreStatus: cs, settled: settled
  }, actor, now.toISOString());

  return { ok: true, loan: loan, settled: settled };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Schedule helpers (exported for testing)
  allocatePaymentToSchedule,
  syncRowStatuses,
  rebuildSummary,
  // Payment mutations
  applyRepayment,
  applyManualPayment,
  refundPayment,
  recordFailedPayment,
  // Payment holiday
  applyPaymentHoliday,
  completePaymentHoliday,
  // Payment arrangement
  applyPaymentArrangement,
  breakPaymentArrangement,
  completePaymentArrangement,
  // Settlement
  triggerSettlementEvaluation,
  // Forbearance / insolvency overlays
  applyForbearanceOverlay,
  exitForbearanceOverlay
};
