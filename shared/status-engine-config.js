/**
 * NovaPay Status Engine Config — v3.0
 * Central configuration for all loan status evaluation thresholds,
 * status codes, overlay types, and precedence rules.
 * Must be loaded before loan-status-engine.js and servicing-policy-engine.js.
 */
;(function (global) {
  'use strict';

  var NovaPay = global.NovaPay || (global.NovaPay = {});

  NovaPay.StatusConfig = {

    // ── Core loan statuses ───────────────────────────────────────────
    CS: {
      ACTIVE:     'active',
      ARREARS:    'arrears',
      DEFAULT:    'default',
      TERMINATED: 'terminated',
      SETTLED:    'settled',
      CLOSED:     'closed'
    },

    // ── Servicing overlay types ──────────────────────────────────────
    OV: {
      PH_ACTIVE:     'payment_holiday_active',
      PH_COMPLETED:  'payment_holiday_completed',
      PH_SUPERSEDED: 'payment_holiday_superseded',
      PA_ACTIVE:     'payment_arrangement_active',
      PA_COMPLETED:  'payment_arrangement_completed',
      PA_BROKEN:     'payment_arrangement_broken'
    },

    // ── Evaluation thresholds ────────────────────────────────────────
    TERMINATION_DAYS:   75,    // Calendar days without a successful payment → terminated
    CONSEC_DEFAULT:      2,    // Consecutive uncleared due instalments → default
    CONSEC_ARREARS:      1,    // One uncleared due instalment → arrears
    PH_ARREARS_GRACE:    5,    // PH still eligible if arrears ≤ 5 days
    BALANCE_TOLERANCE:   0.01, // Amounts ≤ this are treated as zero

    // ── Overlay precedence (highest index wins) ──────────────────────
    // Future formal forbearance types slot above payment_arrangement.
    OV_PRECEDENCE: [
      'payment_holiday',
      'payment_arrangement',
      'formal_forbearance'     // DMP, IVA, PTD, Breathing Space, DRO, Bankruptcy
    ],

    // ── Statuses in which PH is never available ──────────────────────
    PH_BLOCKED_STATUSES: ['default', 'terminated', 'settled', 'closed'],

    // ── Statuses in which PA is never available ──────────────────────
    PA_BLOCKED_STATUSES: ['settled', 'closed'],

    // ── Statuses where the loan is considered fully finished ─────────
    TERMINAL_STATUSES: ['settled', 'closed']
  };

})(typeof window !== 'undefined' ? window : this);
