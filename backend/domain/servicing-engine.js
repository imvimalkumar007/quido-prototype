/**
 * NovaPay Servicing Engine — Node.js
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
  BALANCE_TOLERANCE,
  evaluateCoreStatus,
  checkPHEligibility,
  checkPAEligibility,
  runStatusEngine
} = require('./status-engine');

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
  var partial   = loan.partialCredit || 0;
  var remaining = amount + partial;
  var cleared   = 0;

  for (var i = paidIdx; i < snap.length; i++) {
    var row = snap[i];
    if (row.status === 'paid') continue;

    // PH rows cost nothing — mark and advance
    if (row.ph) {
      row.status = 'paid';
      cleared++;
      continue;
    }

    var rowCost = row.emi || row.principal || 0;
    if (remaining >= rowCost - BALANCE_TOLERANCE) {
      remaining -= rowCost;
      row.status = 'paid';
      cleared++;
    } else {
      break;
    }
  }

  loan.partialCredit = Math.max(0, remaining);
  return cleared;
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
    if (snap[i].status === 'paid') continue;
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
  var partial = loan.partialCredit || 0;

  // EMI = first non-PH row's emi field
  var emiAmt = 0;
  for (var j = 0; j < snap.length; j++) {
    if (!snap[j].ph) { emiAmt = snap[j].emi || 0; break; }
  }

  var totalRepayable = 0;
  var totalInterest  = 0;
  var totalRepaid    = 0;
  var outBal         = 0;
  var remaining      = 0;

  for (var i = 0; i < snap.length; i++) {
    var row = snap[i];
    if (row.ph) continue; // PH rows contribute nothing to financials
    totalRepayable += row.emi || 0;
    totalInterest  += row.interest || 0;
    if (row.status === 'paid') {
      totalRepaid += row.emi || 0;
    } else {
      outBal    += row.principal || 0;
      remaining += 1;
    }
  }

  outBal = Math.max(0, outBal - partial);

  loan.loanSummary = {
    emi:                  +emiAmt.toFixed(2),
    totalRepayable:       +totalRepayable.toFixed(2),
    totalInterest:        +totalInterest.toFixed(2),
    outstandingBalance:   +outBal.toFixed(2),
    totalRepaid:          +totalRepaid.toFixed(2),
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

  if (!Array.isArray(loan.transactions)) loan.transactions = [];
  loan.transactions.push({
    id:         'pmt-' + Date.now(),
    type:       txnType,
    amount:     amount,
    date:       date,
    successful: true,
    actor:      actor
  });

  var cleared = allocatePaymentToSchedule(loan, amount);
  loan.loanCore.paidCount = paidIdx + cleared;
  syncRowStatuses(loan);
  rebuildSummary(loan);
  runStatusEngine(loan, now);

  _pushAudit(loan, 'repayment_recorded', {
    amount: amount, cleared: cleared, txnType: txnType
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

  if (!Array.isArray(loan.transactions)) loan.transactions = [];
  loan.transactions.push({
    id:         'mpmt-' + Date.now(),
    type:       'manual_payment',
    amount:     amount,
    date:       date,
    successful: true,
    actor:      actor
  });

  var paidIdx = (loan.loanCore && loan.loanCore.paidCount) || 0;
  var cleared = allocatePaymentToSchedule(loan, amount);
  loan.loanCore.paidCount = paidIdx + cleared;
  syncRowStatuses(loan);
  rebuildSummary(loan);
  runStatusEngine(loan, now);

  _pushAudit(loan, 'manual_payment_recorded', {
    amount: amount, cleared: cleared
  }, actor, date);

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
  var elig     = checkPHEligibility(loan, seResult.coreStatus, seResult.derivedFlags, now);
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

  var cs      = loan.statusEngineState.coreStatus;
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
  // Payment holiday
  applyPaymentHoliday,
  completePaymentHoliday,
  // Payment arrangement
  applyPaymentArrangement,
  breakPaymentArrangement,
  completePaymentArrangement,
  // Settlement
  triggerSettlementEvaluation
};
