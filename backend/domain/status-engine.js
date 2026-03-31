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

// Forbearance / insolvency overlay type constants.
// Priority (highest first): BANKRUPTCY > TRUST_DEED > DRO > IVA > BREATHING_SPACE > DMP
const FOV = {
  BANKRUPTCY:      'bankruptcy',
  TRUST_DEED:      'trust_deed',
  DRO:             'dro',
  IVA:             'iva',
  BREATHING_SPACE: 'breathing_space',
  DMP:             'dmp'
};

// Ordered highest → lowest for display resolution
const FOV_PRIORITY = [
  FOV.BANKRUPTCY,
  FOV.TRUST_DEED,
  FOV.DRO,
  FOV.IVA,
  FOV.BREATHING_SPACE,
  FOV.DMP
];

// Servicing overlay string values
const SO = {
  PAYMENT_HOLIDAY:     'payment_holiday',
  PAYMENT_ARRANGEMENT: 'payment_arrangement'
};

// Payment Arrangement sub-status string values
const SS = {
  PA_ON_TRACK:  'on_track',
  PA_BEHIND:    'behind_arrangement',
  PA_COMPLETED: 'completed',
  PA_BROKEN:    'broken'
};

const TERMINATION_DAYS  = 75;
const CONSEC_DEFAULT    = 2;
const CONSEC_ARREARS    = 1;
const PH_ARREARS_GRACE  = 5;
const BALANCE_TOLERANCE = 0.01;

const PH_BLOCKED_STATUSES  = ['default', 'terminated', 'settled', 'closed'];
const PA_BLOCKED_STATUSES  = ['settled', 'closed'];
const FOV_BLOCKED_STATUSES = ['settled', 'closed'];
const TERMINAL_STATUSES    = ['settled', 'closed'];

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
  // Read baseStatus first (new model), fall back to coreStatus (legacy stored loans)
  var prevStatus = (loan.statusEngineState &&
    (loan.statusEngineState.baseStatus || loan.statusEngineState.coreStatus)) || CS.ACTIVE;
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

/**
 * Derive the Payment Arrangement sub-status from the PA object.
 * Returns null if no PA is present.
 */
function deriveServicingSubStatus(pa, now) {
  if (!pa) return null;
  if (pa.broken) return SS.PA_BROKEN;

  var allPaid = pa.totalAmount > 0 && (pa.totalPaid || 0) >= pa.totalAmount - BALANCE_TOLERANCE;
  if (allPaid) return SS.PA_COMPLETED;

  if (!pa.active) return null;

  // Behind if totalPaid falls short of what should have been paid by now
  if (pa.startDate && pa.amount > 0) {
    var start         = new Date(pa.startDate);
    var msPerMonth    = 30.4375 * 24 * 3600 * 1000;
    var monthsElapsed = Math.floor((now - start) / msPerMonth);
    var expectedPaid  = +(pa.amount * Math.max(0, monthsElapsed)).toFixed(2);
    if ((pa.totalPaid || 0) < expectedPaid - BALANCE_TOLERANCE) {
      return SS.PA_BEHIND;
    }
  }

  return SS.PA_ON_TRACK;
}

/**
 * Derive the active servicing overlay and its sub-status from loan.arrangements.
 * Payment Arrangement and Payment Holiday are mutually exclusive per eligibility rules.
 *
 * @param {Object} loan
 * @param {Date}   now
 * @returns {{ servicingOverlay: string|null, servicingSubStatus: string|null }}
 */
function deriveServicingState(loan, now) {
  var arrs = loan.arrangements || {};
  var pa   = arrs.paymentArrangement;
  var ph   = arrs.paymentHoliday;

  // PA takes precedence (they should be mutually exclusive, but PA wins if both present)
  if (pa) {
    return {
      servicingOverlay:   SO.PAYMENT_ARRANGEMENT,
      servicingSubStatus: deriveServicingSubStatus(pa, now)
    };
  }

  if (ph && ph.active) {
    return { servicingOverlay: SO.PAYMENT_HOLIDAY, servicingSubStatus: null };
  }

  return { servicingOverlay: null, servicingSubStatus: null };
}

/**
 * Resolve the single displayed status from the four model fields.
 *
 * Priority (highest first):
 *   Bankruptcy > Trust Deed > DRO > IVA > Breathing Space > DMP
 *   > Payment Holiday > Payment Arrangement > baseStatus
 *
 * Note: Payment Holiday and Arrangement are only shown while actively tracking
 * (sub-status on_track or behind_arrangement). Broken and completed PA exits
 * resolve to baseStatus — the base status engine has already recalculated.
 *
 * @param {string}      baseStatus
 * @param {string|null} servicingOverlay
 * @param {string|null} servicingSubStatus
 * @param {string|null} forbearanceOverlay
 * @returns {string}
 */
function resolveDisplayStatus(baseStatus, servicingOverlay, servicingSubStatus, forbearanceOverlay) {
  // Forbearance / insolvency overlays take highest priority
  if (forbearanceOverlay) return forbearanceOverlay;

  // Servicing overlays — only when actively running
  if (servicingOverlay === SO.PAYMENT_HOLIDAY) {
    return SO.PAYMENT_HOLIDAY;
  }
  if (servicingOverlay === SO.PAYMENT_ARRANGEMENT &&
      servicingSubStatus !== SS.PA_BROKEN &&
      servicingSubStatus !== SS.PA_COMPLETED) {
    return SO.PAYMENT_ARRANGEMENT;
  }

  return baseStatus;
}

// ── Eligibility checks ────────────────────────────────────────────────────────

/**
 * @param {Object}  loan
 * @param {string}  coreStatus
 * @param {Object}  derivedFlags
 * @param {Date}    [now]
 * @param {boolean} [bypassCountLimit=false] — when true, the per-loan PH count cap
 *   is not enforced. Pass true for ops-initiated checks; the limit still applies
 *   to customer-facing eligibility.
 */
function checkPHEligibility(loan, coreStatus, derivedFlags, now, bypassCountLimit) {
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

  if (loan.forbearanceOverlay && loan.forbearanceOverlay.active) {
    return { eligible: false, reason: 'A forbearance overlay (' + loan.forbearanceOverlay.type + ') is currently active.' };
  }

  var phHistory = arrs.paymentHolidayHistory || [];
  var phMax     = (lc.termMonths <= 6) ? 1 : 2;
  var phUsed    = phHistory.length + (arrs.paymentHoliday && arrs.paymentHoliday.active ? 1 : 0);
  if (!bypassCountLimit && phUsed >= phMax) {
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

  if (loan.forbearanceOverlay && loan.forbearanceOverlay.active) {
    return { eligible: false, reason: 'A forbearance overlay (' + loan.forbearanceOverlay.type + ') is currently active.' };
  }

  var pa = arrs.paymentArrangement;
  if (pa && pa.active && !pa.broken) {
    return { eligible: false, reason: 'A payment arrangement is already active on this account.' };
  }

  return { eligible: true };
}

/**
 * Check whether a forbearance/insolvency overlay can be applied.
 *
 * Blocked when:
 *   - coreStatus is 'settled' or 'closed'
 *   - another forbearance overlay is already active
 *
 * @param {Object} loan
 * @param {string} coreStatus — evaluated core status
 * @returns {{ eligible: boolean, reason?: string }}
 */
function checkForbearanceEligibility(loan, coreStatus) {
  if (FOV_BLOCKED_STATUSES.indexOf(coreStatus) !== -1) {
    return { eligible: false, reason: 'Forbearance overlays cannot be applied when account status is ' + coreStatus + '.' };
  }

  if (loan.forbearanceOverlay && loan.forbearanceOverlay.active) {
    return { eligible: false, reason: 'A forbearance overlay (' + loan.forbearanceOverlay.type + ') is already active on this account.' };
  }

  return { eligible: true };
}

// ── Allowed / blocked actions ─────────────────────────────────────────────────

/**
 * Derive which servicing actions are currently permitted or blocked.
 * @param {Object} loan
 * @param {string} coreStatus  — evaluated base status
 * @param {Object} derivedFlags
 * @param {Date}   [now]
 * @returns {{ allowedActions: string[], blockedActions: string[], reasons: Object }}
 */
function deriveAllowedActions(loan, coreStatus, derivedFlags, now) {
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

  // Forbearance / insolvency overlays
  var fovElig = checkForbearanceEligibility(loan, coreStatus);
  if (fovElig.eligible) {
    allowed.push('apply_forbearance_overlay');
  } else {
    blocked.push('apply_forbearance_overlay');
    reasons['apply_forbearance_overlay'] = fovElig.reason;
  }

  if (loan.forbearanceOverlay && loan.forbearanceOverlay.active) {
    allowed.push('exit_forbearance_overlay');
  } else {
    blocked.push('exit_forbearance_overlay');
    reasons['exit_forbearance_overlay'] = 'No active forbearance overlay.';
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
 * Run the full status evaluation and write the canonical 4-field model
 * to loan.statusEngineState in place.
 *
 * Written fields:
 *   baseStatus             — evaluated lifecycle status (CS.*)
 *   servicingOverlay       — active servicing program (SO.* | null)
 *   servicingSubStatus     — arrangement performance state (SS.* | null)
 *   forbearanceOverlay     — active forbearance/insolvency type (FOV.* | null)
 *   resolvedDisplayStatus  — single status shown in UI
 *   reasonCodes            — reasons for current baseStatus
 *   derivedFlags           — numeric flags (outstandingBalance, etc.)
 *   lastEvaluatedAt        — ISO timestamp
 *
 * @param {Object} loan
 * @param {Date}   [now]
 * @returns {Object} updated statusEngineState
 */
function runStatusEngine(loan, now) {
  now = now || new Date();

  var seResult   = evaluateCoreStatus(loan, now);
  var svcState   = deriveServicingState(loan, now);
  var fovType    = (loan.forbearanceOverlay && loan.forbearanceOverlay.active)
    ? loan.forbearanceOverlay.type
    : null;
  var display    = resolveDisplayStatus(
    seResult.coreStatus,
    svcState.servicingOverlay,
    svcState.servicingSubStatus,
    fovType
  );

  loan.statusEngineState = {
    baseStatus:            seResult.coreStatus,
    servicingOverlay:      svcState.servicingOverlay,
    servicingSubStatus:    svcState.servicingSubStatus,
    forbearanceOverlay:    fovType,
    resolvedDisplayStatus: display,
    reasonCodes:           seResult.reasonCodes  || [],
    derivedFlags:          seResult.derivedFlags || {},
    lastEvaluatedAt:       now.toISOString()
  };

  // Mark loan closed/settled when it reaches a terminal state
  var bs = seResult.coreStatus;
  if ((bs === CS.CLOSED || bs === CS.SETTLED) && !loan.closedAt) {
    loan.closedAt      = now.toISOString();
    loan.closureReason = bs;
    if (bs === CS.SETTLED) loan.settlementDate = now.toISOString();
  }

  return loan.statusEngineState;
}

module.exports = {
  CS,
  OV,
  FOV,
  FOV_PRIORITY,
  SO,
  SS,
  TERMINATION_DAYS,
  CONSEC_DEFAULT,
  CONSEC_ARREARS,
  PH_ARREARS_GRACE,
  BALANCE_TOLERANCE,
  PH_BLOCKED_STATUSES,
  PA_BLOCKED_STATUSES,
  FOV_BLOCKED_STATUSES,
  TERMINAL_STATUSES,
  outstandingBalance,
  lastSuccessfulPaymentDate,
  daysSince,
  countMissedDueInstalments,
  evaluateCoreStatus,
  deriveServicingSubStatus,
  deriveServicingState,
  resolveDisplayStatus,
  checkPHEligibility,
  checkPAEligibility,
  checkForbearanceEligibility,
  deriveAllowedActions,
  runStatusEngine
};
