/**
 * Quido Servicing Policy Engine — v3.0
 * Manages servicing overlays (Payment Holiday, Payment Arrangement)
 * and forbearance eligibility rules on top of the core loan status.
 * Depends on: status-engine-config.js, loan-status-engine.js
 *
 * Overlay precedence (highest wins):
 *   formal_forbearance > payment_arrangement > payment_holiday > core status
 *
 * Future forbearance policy packs (DMP, IVA, PTD, Breathing Space, DRO,
 * Bankruptcy) slot in at the formal_forbearance level — add a forbearanceCases[]
 * entry and implement a matching evaluator in the same pattern below.
 */
;(function (global) {
  'use strict';

  var Quido = global.Quido || (global.Quido = {});

  // ── Overlay evaluation ───────────────────────────────────────────

  /**
   * Evaluate all active overlays for a loan and return the overlay map.
   * @param {Object} loan         - v3 loan object
   * @param {string} coreStatus   - result from loanStatusEngine.evaluateCoreStatus
   * @param {Date}   now
   * @returns {Object} overlays   - keyed by overlay category
   */
  function evaluateOverlays(loan, coreStatus, now) {
    var SC   = Quido.StatusConfig;
    now      = now || new Date();
    var arrs = loan.arrangements || {};
    var overlays = {};

    // ── 1. Formal forbearance (future packs) ─────────────────────
    var cases = loan.forbearanceCases || [];
    for (var fc = 0; fc < cases.length; fc++) {
      var c = cases[fc];
      if (c.active) {
        overlays.formalForbearance = {
          type:      c.type,
          startDate: c.startDate,
          endDate:   c.endDate,
          reference: c.reference
        };
        break; // only one active formal case at a time
      }
    }

    // ── 2. Payment Arrangement ────────────────────────────────────
    var pa = arrs.paymentArrangement;
    if (pa) {
      var paEndDate  = pa.endDate   ? new Date(pa.endDate)  : null;
      var paTotalAmt = pa.totalAmount || 0;
      var paTotalPaid = pa.totalPaid  || 0;
      var paAllPaid  = paTotalAmt > 0 && paTotalPaid >= paTotalAmt - SC.BALANCE_TOLERANCE;

      if (paAllPaid) {
        overlays.paymentArrangement = {
          type:       SC.OV.PA_COMPLETED,
          startDate:  pa.startDate,
          endDate:    pa.endDate,
          amount:     pa.amount,
          totalPaid:  paTotalPaid
        };
      } else if (pa.broken) {
        overlays.paymentArrangement = {
          type:      SC.OV.PA_BROKEN,
          startDate: pa.startDate,
          brokenAt:  pa.brokenAt
        };
      } else if (paEndDate && now > paEndDate && !paAllPaid) {
        // Expired without completion — treat as broken
        overlays.paymentArrangement = {
          type:      SC.OV.PA_BROKEN,
          startDate: pa.startDate,
          endDate:   pa.endDate
        };
      } else if (pa.active) {
        overlays.paymentArrangement = {
          type:      SC.OV.PA_ACTIVE,
          startDate: pa.startDate,
          endDate:   pa.endDate,
          amount:    pa.amount,
          months:    pa.months
        };
      }
    }

    // ── 3. Payment Holiday ────────────────────────────────────────
    var ph = arrs.paymentHoliday;
    if (ph && ph.active) {
      var phEndDate  = ph.endDate ? new Date(ph.endDate) : null;
      var paIsActive = overlays.paymentArrangement &&
                       overlays.paymentArrangement.type === SC.OV.PA_ACTIVE;
      var ffIsActive = !!overlays.formalForbearance;

      if (ffIsActive || paIsActive) {
        overlays.paymentHoliday = { type: SC.OV.PH_SUPERSEDED };
      } else if (phEndDate && now > phEndDate) {
        overlays.paymentHoliday = { type: SC.OV.PH_COMPLETED, endDate: ph.endDate };
      } else {
        overlays.paymentHoliday = {
          type:      SC.OV.PH_ACTIVE,
          startDate: ph.startDate,
          endDate:   ph.endDate
        };
      }
    }

    return overlays;
  }

  /**
   * Derive the display status shown to users from core status + overlays.
   * Highest-precedence active overlay wins over core status.
   */
  function resolveDisplayStatus(coreStatus, overlays) {
    var SC = Quido.StatusConfig;
    if (overlays.formalForbearance) {
      return overlays.formalForbearance.type || 'forbearance';
    }
    if (overlays.paymentArrangement &&
        overlays.paymentArrangement.type === SC.OV.PA_ACTIVE) {
      return 'arrangement';
    }
    if (overlays.paymentHoliday &&
        overlays.paymentHoliday.type === SC.OV.PH_ACTIVE) {
      return 'holiday';
    }
    return coreStatus;
  }

  // ── Eligibility checks ───────────────────────────────────────────

  /**
   * Check whether a Payment Holiday can be applied to this loan right now.
   * @param {Object} loan
   * @param {string} coreStatus
   * @param {Object} derivedFlags  - from loanStatusEngine result
   * @param {Date}   now
   * @returns {{ eligible: boolean, reason?: string, phUsed?: number, phMax?: number }}
   */
  function checkPHEligibility(loan, coreStatus, derivedFlags, now) {
    var SC   = Quido.StatusConfig;
    now      = now || new Date();
    var arrs = loan.arrangements || {};
    var lc   = loan.loanCore     || {};

    // Blocked core statuses
    if (SC.PH_BLOCKED_STATUSES.indexOf(coreStatus) !== -1) {
      return { eligible: false, reason: 'Payment holidays are not available when your account is ' + coreStatus + '.' };
    }

    // Arrears grace window: only eligible if ≤ 5 days past due
    if (coreStatus === SC.CS.ARREARS) {
      var dpd = (derivedFlags && derivedFlags.daysSinceLastPayment) || 0;
      if (dpd > SC.PH_ARREARS_GRACE) {
        return { eligible: false, reason: 'Payment holidays are not available — your account has been in arrears for more than ' + SC.PH_ARREARS_GRACE + ' days.' };
      }
    }

    // Active Payment Arrangement supersedes PH
    if (arrs.paymentArrangement && arrs.paymentArrangement.active && !arrs.paymentArrangement.broken) {
      return { eligible: false, reason: 'A payment arrangement is already active on your account.' };
    }

    // Active formal forbearance blocks PH
    var cases = loan.forbearanceCases || [];
    for (var fc = 0; fc < cases.length; fc++) {
      if (cases[fc].active) {
        return { eligible: false, reason: 'A formal forbearance case is active on your account.' };
      }
    }

    // Count PH uses
    var phHistory = arrs.paymentHolidayHistory || [];
    var phMax     = (lc.termMonths <= 6) ? 1 : 2;
    var phUsed    = phHistory.length + (arrs.paymentHoliday && arrs.paymentHoliday.active ? 1 : 0);
    if (phUsed >= phMax) {
      return {
        eligible: false,
        reason:   'You have used ' + phUsed + ' of ' + phMax + ' payment holiday' + (phMax > 1 ? 's' : '') + ' available on this loan.'
      };
    }

    // Window check: must apply before or within 5 days after the current due date
    var snap    = loan.scheduleSnapshot || [];
    var paid    = lc.paidCount || 0;
    var nextRow = snap[paid] || null;
    if (nextRow) {
      var windowEnd = new Date(nextRow.dueDate);
      windowEnd.setDate(windowEnd.getDate() + SC.PH_ARREARS_GRACE);
      if (now > windowEnd) {
        return { eligible: false, reason: 'The application window for this payment has closed.' };
      }
    }

    return { eligible: true, phUsed: phUsed, phMax: phMax };
  }

  /**
   * Check whether a Payment Arrangement can be applied.
   * @param {Object} loan
   * @param {string} coreStatus
   * @returns {{ eligible: boolean, reason?: string }}
   */
  function checkPAEligibility(loan, coreStatus) {
    var SC   = Quido.StatusConfig;
    var arrs = loan.arrangements || {};

    if (SC.PA_BLOCKED_STATUSES.indexOf(coreStatus) !== -1) {
      return { eligible: false, reason: 'Payment arrangements are not available when your account is ' + coreStatus + '.' };
    }

    // Once set, a PA cannot be removed — but a broken/completed one allows a new one
    var pa = arrs.paymentArrangement;
    if (pa && pa.active && !pa.broken) {
      return { eligible: false, reason: 'A payment arrangement is already active on this account.' };
    }

    return { eligible: true };
  }

  // ── Public API ───────────────────────────────────────────────────
  Quido.servicingPolicyEngine = {
    evaluateOverlays:      evaluateOverlays,
    resolveDisplayStatus:  resolveDisplayStatus,
    checkPHEligibility:    checkPHEligibility,
    checkPAEligibility:    checkPAEligibility
  };

})(typeof window !== 'undefined' ? window : this);
