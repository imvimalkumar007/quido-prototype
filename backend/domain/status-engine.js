/**
 * Quido Status Engine — Node.js
 *
 * Server-side port of shared/loan-status-engine.js + shared/servicing-policy-engine.js
 * + shared/status-engine-config.js.
 *
 * Pure functions. No global state. All constants defined locally.
 *
 * Evaluation order after every loan mutation:
 *  1. Balance ≤ tolerance  →  settled (if previously terminated) | closed
 *  2. Previously terminated + balance > 0  →  remain terminated
 *  3. Days since last successful payment ≥ 75  →  terminated
 *  4. 2 consecutive uncleared due instalments  →  default
 *  5. 1 uncleared due instalment  →  arrears
 *  6. Otherwise  →  active
 */
'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

const CS = {
  ACTIVE:     'active',
  ARREARS:    'arrears',
  DEFAULT:    'default',
  TERMINATED: 'terminated',
  SETTLED:    'settled',
  CLOSED:     'closed'
};

const OV = {
  PH_ACTIVE:     'payment_holiday_active',
  PH_COMPLETED:  'payment_holiday_completed',
  PH_SUPERSEDED: 'payment_holiday_superseded',
  PA_ACTIVE:     'payment_arrangement_active',
  PA_COMPLETED:  'payment_arrangement_completed',
  PA_BROKEN:     'payment_arrangement_broken'
};

const TERMINATION_DAYS  = 75;
const CONSEC_DEFAULT    = 2;
const CONSEC_ARREARS    = 1;
const PH_ARREARS_GRACE  = 5;
const BALANCE_TOLERANCE = 0.01;

const PH_BLOCKED_STATUSES = ['default', 'terminated', 'settled', 'closed'];
const PA_BLOCKED_STATUSES = ['settled', 'closed'];
const TERMINAL_STATUSES   = ['settled', 'closed'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function outstandingBalance(loan) {
  var snap      = loan.scheduleSnapshot || [];
  var paid      = (loan.loanCore && loan.loanCore.paidCount) || 0;
  var partial   = loan.partialCredit || 0;
  if (snap.length) {
    var bal = snap.slice(paid)
      .filter(function (r) { return !r.ph; })
      .reduce(function (acc, r) { return acc + (r.principal || 0); }, 0);
    return Math.max(0, bal - partial);
  }
  return Math.max(0, ((loan.loanCore && loan.loanCore.principal) || 0) - partial);
}

function lastSuccessfulPaymentDate(loan) {
  var txns = loan.transactions || [];
  for (var i = txns.length - 1; i >= 0; i--) {
    var t = txns[i];
    if ((t.type === 'payment' || t.type === 'partial_payment' || t.type === 'manual_payment')
        && t.successful !== false) {
      return new Date(t.date || t.timestamp);
    }
  }
  // Derive from schedule: last paid instalment's due date
  var paid = (loan.loanCore && loan.loanCore.paidCount) || 0;
  var snap = loan.scheduleSnapshot || [];
  for (var j = paid - 1; j >= 0; j--) {
    if (snap[j] && !snap[j].ph) return new Date(snap[j].dueDate);
  }
  if (loan.originatedAt)                         return new Date(loan.originatedAt);
  if (loan.loanCore && loan.loanCore.startDate)  return new Date(loan.loanCore.startDate);
  return null;
}

function daysSince(date, now) {
  if (!date) return 0;
  return Math.max(0, Math.floor((now - date) / 86400000));
}

function countMissedDueInstalments(loan, now) {
  var snap   = loan.scheduleSnapshot || [];
  var paid   = (loan.loanCore && loan.loanCore.paidCount) || 0;
  var missed = 0;
  for (var i = paid; i < snap.length; i++) {
    var row = snap[i];
    if (row.status === 'paid') continue;
    if (row.ph || row.pa) { missed = 0; continue; }
    var due = new Date(row.dueDate);
    if (due > now) break;
    missed++;
  }
  return missed;
}

// ── Core status evaluator ─────────────────────────────────────────────────────

/**
 * Evaluate the canonical core status of a loan.
 * @param {Object} loan
 * @param {Date}   [now]
 * @returns {{ coreStatus, reasonCodes, derivedFlags }}
 */
function evaluateCoreStatus(loan, now) {
  now = now || new Date();
  var prevStatus = (loan.statusEngineState && loan.statusEngineState.coreStatus) || CS.ACTIVE;
  var bal        = outstandingBalance(loan);
  var lastPmt    = lastSuccessfulPaymentDate(loan);
  var daysNoPmt  = daysSince(lastPmt, now);

  // Rule 1: balance cleared
  if (bal <= BALANCE_TOLERANCE) {
    return {
      coreStatus:   prevStatus === CS.TERMINATED ? CS.SETTLED : CS.CLOSED,
      reasonCodes:  ['balance_cleared'],
      derivedFlags: { outstandingBalance: bal, daysSinceLastPayment: daysNoPmt, fullyRepaid: true }
    };
  }

  // Rule 2: was terminated, still has balance
  if (prevStatus === CS.TERMINATED || prevStatus === CS.SETTLED) {
    return {
      coreStatus:   CS.TERMINATED,
      reasonCodes:  ['previously_terminated_balance_remains'],
      derivedFlags: { outstandingBalance: bal, daysSinceLastPayment: daysNoPmt }
    };
  }

  // Rule 3: 75+ days no successful payment
  if (daysNoPmt >= TERMINATION_DAYS) {
    return {
      coreStatus:   CS.TERMINATED,
      reasonCodes:  ['no_payment_' + daysNoPmt + '_days'],
      derivedFlags: { outstandingBalance: bal, daysSinceLastPayment: daysNoPmt }
    };
  }

  // Rules 4 & 5: missed instalments
  var missed = countMissedDueInstalments(loan, now);

  if (missed >= CONSEC_DEFAULT) {
    return {
      coreStatus:   CS.DEFAULT,
      reasonCodes:  ['consecutive_missed_instalments_' + missed],
      derivedFlags: { outstandingBalance: bal, missedInstalments: missed, daysSinceLastPayment: daysNoPmt }
    };
  }

  if (missed >= CONSEC_ARREARS) {
    return {
      coreStatus:   CS.ARREARS,
      reasonCodes:  ['missed_instalment_' + missed],
      derivedFlags: { outstandingBalance: bal, missedInstalments: missed, daysSinceLastPayment: daysNoPmt }
    };
  }

  // Rule 6: active
  return {
    coreStatus:   CS.ACTIVE,
    reasonCodes:  [],
    derivedFlags: { outstandingBalance: bal, missedInstalments: 0, daysSinceLastPayment: daysNoPmt }
  };
}

// ── Overlay evaluator ─────────────────────────────────────────────────────────

function evaluateOverlays(loan, coreStatus, now) {
  now  = now || new Date();
  var arrs     = loan.arrangements || {};
  var overlays = {};

  // 1. Formal forbearance (future packs — placeholder)
  var cases = loan.forbearanceCases || [];
  for (var fc = 0; fc < cases.length; fc++) {
    if (cases[fc].active) {
      overlays.formalForbearance = { type: cases[fc].type, startDate: cases[fc].startDate, endDate: cases[fc].endDate };
      break;
    }
  }

  // 2. Payment Arrangement
  var pa = arrs.paymentArrangement;
  if (pa) {
    var paEnd    = pa.endDate ? new Date(pa.endDate) : null;
    var paAllPaid = pa.totalAmount > 0 && (pa.totalPaid || 0) >= pa.totalAmount - BALANCE_TOLERANCE;

    if (paAllPaid) {
      overlays.paymentArrangement = { type: OV.PA_COMPLETED, startDate: pa.startDate, endDate: pa.endDate, totalPaid: pa.totalPaid };
    } else if (pa.broken) {
      overlays.paymentArrangement = { type: OV.PA_BROKEN, startDate: pa.startDate, brokenAt: pa.brokenAt };
    } else if (paEnd && now > paEnd && !paAllPaid) {
      overlays.paymentArrangement = { type: OV.PA_BROKEN, startDate: pa.startDate, endDate: pa.endDate };
    } else if (pa.active) {
      overlays.paymentArrangement = { type: OV.PA_ACTIVE, startDate: pa.startDate, endDate: pa.endDate, amount: pa.amount, months: pa.months };
    }
  }

  // 3. Payment Holiday
  var ph = arrs.paymentHoliday;
  if (ph && ph.active) {
    var phEnd      = ph.endDate ? new Date(ph.endDate) : null;
    var paIsActive = overlays.paymentArrangement && overlays.paymentArrangement.type === OV.PA_ACTIVE;
    var ffIsActive = !!overlays.formalForbearance;

    if (ffIsActive || paIsActive) {
      overlays.paymentHoliday = { type: OV.PH_SUPERSEDED };
    } else if (phEnd && now > phEnd) {
      overlays.paymentHoliday = { type: OV.PH_COMPLETED, endDate: ph.endDate };
    } else {
      overlays.paymentHoliday = { type: OV.PH_ACTIVE, startDate: ph.startDate, endDate: ph.endDate };
    }
  }

  return overlays;
}

function resolveDisplayStatus(coreStatus, overlays) {
  if (overlays.formalForbearance) return overlays.formalForbearance.type || 'forbearance';
  if (overlays.paymentArrangement && overlays.paymentArrangement.type === OV.PA_ACTIVE) return 'arrangement';
  if (overlays.paymentHoliday     && overlays.paymentHoliday.type     === OV.PH_ACTIVE) return 'holiday';
  return coreStatus;
}

// ── Eligibility checks ────────────────────────────────────────────────────────

function checkPHEligibility(loan, coreStatus, derivedFlags, now) {
  now  = now || new Date();
  var arrs = loan.arrangements || {};
  var lc   = loan.loanCore     || {};

  if (PH_BLOCKED_STATUSES.indexOf(coreStatus) !== -1) {
    return { eligible: false, reason: 'Payment holidays are not available when account status is ' + coreStatus + '.' };
  }

  if (coreStatus === CS.ARREARS) {
    var dpd = (derivedFlags && derivedFlags.daysSinceLastPayment) || 0;
    if (dpd > PH_ARREARS_GRACE) {
      return { eligible: false, reason: 'Payment holiday not available — account has been in arrears for more than ' + PH_ARREARS_GRACE + ' days.' };
    }
  }

  if (arrs.paymentArrangement && arrs.paymentArrangement.active && !arrs.paymentArrangement.broken) {
    return { eligible: false, reason: 'A payment arrangement is already active on this account.' };
  }

  var cases = loan.forbearanceCases || [];
  for (var fc = 0; fc < cases.length; fc++) {
    if (cases[fc].active) return { eligible: false, reason: 'A formal forbearance case is active.' };
  }

  var phHistory = arrs.paymentHolidayHistory || [];
  var phMax     = (lc.termMonths <= 6) ? 1 : 2;
  var phUsed    = phHistory.length + (arrs.paymentHoliday && arrs.paymentHoliday.active ? 1 : 0);
  if (phUsed >= phMax) {
    return { eligible: false, reason: 'Maximum payment holidays (' + phMax + ') already used on this loan.' };
  }

  var snap    = loan.scheduleSnapshot || [];
  var paid    = lc.paidCount || 0;
  var nextRow = snap[paid] || null;
  if (nextRow) {
    var windowEnd = new Date(nextRow.dueDate);
    windowEnd.setDate(windowEnd.getDate() + PH_ARREARS_GRACE);
    if (now > windowEnd) {
      return { eligible: false, reason: 'Application window for this payment has closed.' };
    }
  }

  return { eligible: true, phUsed: phUsed, phMax: phMax };
}

function checkPAEligibility(loan, coreStatus) {
  var arrs = loan.arrangements || {};

  if (PA_BLOCKED_STATUSES.indexOf(coreStatus) !== -1) {
    return { eligible: false, reason: 'Payment arrangements not available when account status is ' + coreStatus + '.' };
  }

  var pa = arrs.paymentArrangement;
  if (pa && pa.active && !pa.broken) {
    return { eligible: false, reason: 'A payment arrangement is already active on this account.' };
  }

  return { eligible: true };
}

// ── Allowed / blocked actions ─────────────────────────────────────────────────

/**
 * Derive which servicing actions are currently permitted or blocked.
 * @param {Object} loan
 * @param {string} coreStatus
 * @param {Object} overlays
 * @param {Object} derivedFlags
 * @param {Date}   [now]
 * @returns {{ allowedActions: string[], blockedActions: string[], reasons: Object }}
 */
function deriveAllowedActions(loan, coreStatus, overlays, derivedFlags, now) {
  var allowed  = [];
  var blocked  = [];
  var reasons  = {};

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
  var phElig = checkPHEligibility(loan, coreStatus, derivedFlags, now);
  if (phElig.eligible) {
    allowed.push('apply_payment_holiday');
  } else {
    blocked.push('apply_payment_holiday');
    reasons['apply_payment_holiday'] = phElig.reason;
  }

  // Payment Arrangement
  var paElig = checkPAEligibility(loan, coreStatus);
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

// ── Full engine runner ────────────────────────────────────────────────────────

/**
 * Run the full status + overlay evaluation and update loan.statusEngineState in place.
 * @param {Object} loan
 * @param {Date}   [now]
 * @returns {Object} updated statusEngineState
 */
function runStatusEngine(loan, now) {
  now = now || new Date();
  var seResult = evaluateCoreStatus(loan, now);
  var overlays = evaluateOverlays(loan, seResult.coreStatus, now);
  var display  = resolveDisplayStatus(seResult.coreStatus, overlays);

  loan.statusEngineState = {
    coreStatus:      seResult.coreStatus,
    overlays:        overlays,
    displayStatus:   display,
    reasonCodes:     seResult.reasonCodes  || [],
    derivedFlags:    seResult.derivedFlags || {},
    lastEvaluatedAt: now.toISOString()
  };

  // Mark loan closed/settled
  var cs = seResult.coreStatus;
  if ((cs === CS.CLOSED || cs === CS.SETTLED) && !loan.closedAt) {
    loan.closedAt      = now.toISOString();
    loan.closureReason = cs;
    if (cs === CS.SETTLED) loan.settlementDate = now.toISOString();
  }

  return loan.statusEngineState;
}

module.exports = {
  CS,
  OV,
  TERMINATION_DAYS,
  CONSEC_DEFAULT,
  CONSEC_ARREARS,
  PH_ARREARS_GRACE,
  BALANCE_TOLERANCE,
  PH_BLOCKED_STATUSES,
  PA_BLOCKED_STATUSES,
  TERMINAL_STATUSES,
  outstandingBalance,
  lastSuccessfulPaymentDate,
  daysSince,
  countMissedDueInstalments,
  evaluateCoreStatus,
  evaluateOverlays,
  resolveDisplayStatus,
  checkPHEligibility,
  checkPAEligibility,
  deriveAllowedActions,
  runStatusEngine
};
