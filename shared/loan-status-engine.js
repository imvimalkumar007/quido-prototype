/**
 * NovaPay Loan Status Engine — v3.0
 * Evaluates the canonical core status of a single loan object.
 * Depends on: status-engine-config.js
 *
 * Evaluation order (per spec):
 *  1. Balance ≤ tolerance  →  settled (if previously terminated) | closed
 *  2. Previously terminated + balance > 0  →  remain terminated
 *  3. Days since last successful payment ≥ 75  →  terminated
 *  4. 2 consecutive uncleared due instalments  →  default
 *  5. 1 uncleared due instalment  →  arrears
 *  6. Otherwise  →  active
 *
 * Payment semantics:
 *  - Partial payment in arrears  → reduces balance but stays arrears unless instalment fully cured
 *  - Partial payment in default  → reduces balance/oldest debt but stays default unless all cured
 *  - Partial payment in terminated → stays terminated unless balance reaches zero (→ settled)
 *  - Full repayment before termination  → closed
 *  - Full repayment after termination   → settled
 */
;(function (global) {
  'use strict';

  var NovaPay = global.NovaPay || (global.NovaPay = {});

  // ── Helpers ──────────────────────────────────────────────────────

  function outstandingBalance(loan) {
    var snap = loan.scheduleSnapshot || [];
    var paid = (loan.loanCore && loan.loanCore.paidCount) || 0;
    if (snap.length) {
      var bal = 0;
      for (var i = paid; i < snap.length; i++) {
        var row = snap[i];
        // Skip ph/pa rows with zero principal contribution
        bal += (row.principal || 0);
      }
      return bal;
    }
    // Fallback: full principal if no schedule built yet
    return (loan.loanCore && loan.loanCore.principal) || 0;
  }

  /**
   * Returns the date of the most recent successful payment.
   * Checks transactions[] first, then falls back to schedule + paidCount.
   */
  function lastSuccessfulPaymentDate(loan) {
    var txns = loan.transactions || [];
    for (var i = txns.length - 1; i >= 0; i--) {
      var t = txns[i];
      if ((t.type === 'payment' || t.type === 'manual_payment') && t.successful !== false) {
        return new Date(t.date || t.timestamp);
      }
    }
    // Derive from schedule: last paid instalment's due date
    var paid    = (loan.loanCore && loan.loanCore.paidCount) || 0;
    var snap    = loan.scheduleSnapshot || [];
    // Walk paid rows to find latest non-PH instalment
    for (var j = paid - 1; j >= 0; j--) {
      if (snap[j] && !snap[j].ph) {
        return new Date(snap[j].dueDate);
      }
    }
    // No payments yet — use origination date so new loans don't instantly terminate
    if (loan.originatedAt) return new Date(loan.originatedAt);
    if (loan.loanCore && loan.loanCore.startDate) return new Date(loan.loanCore.startDate);
    return null;
  }

  function daysSince(date, now) {
    if (!date) return 0;
    return Math.max(0, Math.floor((now - date) / 86400000));
  }

  /**
   * Count consecutive uncleared due instalments starting from the current unpaid one.
   * PH and PA instalments are excluded from the miss count.
   */
  function countMissedDueInstalments(loan, now) {
    var snap    = loan.scheduleSnapshot || [];
    var paid    = (loan.loanCore && loan.loanCore.paidCount) || 0;
    var missed  = 0;

    for (var i = paid; i < snap.length; i++) {
      var row = snap[i];
      if (row.status === 'paid') continue;
      // PH and PA instalments don't count as missed
      if (row.ph || row.pa) { missed = 0; continue; }
      var due = new Date(row.dueDate);
      if (due > now) break; // not yet due
      missed++;
    }
    return missed;
  }

  // ── Main evaluator ───────────────────────────────────────────────

  /**
   * Evaluate the core loan status.
   * @param {Object} loan  - A v3 loan object from customerAccount.loans[]
   * @param {Date}   now   - Optional override for "today" (default: new Date())
   * @returns {{ coreStatus, reasonCodes, derivedFlags }}
   */
  function evaluateCoreStatus(loan, now) {
    var SC = NovaPay.StatusConfig;
    now = now || new Date();

    var prevStatus = (loan.statusEngineState && loan.statusEngineState.coreStatus) || SC.CS.ACTIVE;
    var bal        = outstandingBalance(loan);
    var lastPmt    = lastSuccessfulPaymentDate(loan);
    var daysNoPmt  = daysSince(lastPmt, now);

    // ── Rule 1: balance fully repaid ─────────────────────────────
    if (bal <= SC.BALANCE_TOLERANCE) {
      var newStatus = (prevStatus === SC.CS.TERMINATED) ? SC.CS.SETTLED : SC.CS.CLOSED;
      return {
        coreStatus:  newStatus,
        reasonCodes: ['balance_cleared'],
        derivedFlags: {
          outstandingBalance:    bal,
          daysSinceLastPayment:  daysNoPmt,
          fullyRepaid:           true
        }
      };
    }

    // ── Rule 2: loan was terminated, still has balance ────────────
    if (prevStatus === SC.CS.TERMINATED || prevStatus === SC.CS.SETTLED) {
      return {
        coreStatus:  SC.CS.TERMINATED,
        reasonCodes: ['previously_terminated_balance_remains'],
        derivedFlags: {
          outstandingBalance:   bal,
          daysSinceLastPayment: daysNoPmt
        }
      };
    }

    // ── Rule 3: 75+ consecutive days without a successful payment ─
    if (daysNoPmt >= SC.TERMINATION_DAYS) {
      return {
        coreStatus:  SC.CS.TERMINATED,
        reasonCodes: ['no_payment_' + daysNoPmt + '_days'],
        derivedFlags: {
          outstandingBalance:   bal,
          daysSinceLastPayment: daysNoPmt
        }
      };
    }

    // ── Rules 4 & 5: consecutive missed due instalments ──────────
    var missed = countMissedDueInstalments(loan, now);

    if (missed >= SC.CONSEC_DEFAULT) {
      return {
        coreStatus:  SC.CS.DEFAULT,
        reasonCodes: ['consecutive_missed_instalments_' + missed],
        derivedFlags: {
          outstandingBalance:   bal,
          missedInstalments:    missed,
          daysSinceLastPayment: daysNoPmt
        }
      };
    }

    if (missed >= SC.CONSEC_ARREARS) {
      return {
        coreStatus:  SC.CS.ARREARS,
        reasonCodes: ['missed_instalment_' + missed],
        derivedFlags: {
          outstandingBalance:   bal,
          missedInstalments:    missed,
          daysSinceLastPayment: daysNoPmt
        }
      };
    }

    // ── Rule 6: active ────────────────────────────────────────────
    return {
      coreStatus:  SC.CS.ACTIVE,
      reasonCodes: [],
      derivedFlags: {
        outstandingBalance:   bal,
        missedInstalments:    0,
        daysSinceLastPayment: daysNoPmt
      }
    };
  }

  // ── Public API ───────────────────────────────────────────────────
  NovaPay.loanStatusEngine = {
    evaluateCoreStatus:           evaluateCoreStatus,
    outstandingBalance:           outstandingBalance,
    lastSuccessfulPaymentDate:    lastSuccessfulPaymentDate,
    countMissedDueInstalments:    countMissedDueInstalments
  };

})(typeof window !== 'undefined' ? window : this);
