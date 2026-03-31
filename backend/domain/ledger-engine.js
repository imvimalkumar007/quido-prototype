/**
 * Quido Ledger Engine — Node.js
 *
 * Minimal ledger discipline for loan servicing.
 *
 * Provides an append-only entry log and running totals on each loan.
 * Deliberately kept simple: no double-entry, no chart of accounts.
 * Goal is reliable balance tracking across payments, waivers, and
 * adjustments without requiring full schedule replay.
 *
 * Ledger structure on a loan:
 *   loan.ledger = {
 *     entries: [ { id, type, amount, date, actor, ref } ],
 *     totals:  { principalDue, interestDue, cashReceived,
 *                waivedAmount, adjustmentAmount }
 *   }
 *
 * netDue = (principalDue + interestDue) - cashReceived - waivedAmount + adjustmentAmount
 *
 * Entry types:
 *   principal_due    — instalment principal falling due (posted when instalment becomes current)
 *   interest_due     — instalment interest falling due
 *   cash_received    — successful payment received (repayment or manual)
 *   waived           — amount formally waived (interest waiver, write-off)
 *   adjustment       — other balance adjustment (positive = increases amount owed)
 *   reversal         — reverses a prior cash_received entry
 */
'use strict';

// ── Entry type constants ──────────────────────────────────────────────────────

const ENTRY_TYPES = {
  PRINCIPAL_DUE: 'principal_due',
  INTEREST_DUE:  'interest_due',
  CASH_RECEIVED: 'cash_received',
  WAIVED:        'waived',
  ADJUSTMENT:    'adjustment',
  REVERSAL:      'reversal'
};

// ── Initialisation ────────────────────────────────────────────────────────────

/**
 * Ensure loan.ledger exists with the correct shape.
 * Safe to call on any loan — existing entries and totals are preserved.
 */
function initLedgerIfNeeded(loan) {
  if (!loan.ledger) {
    loan.ledger = { entries: [], totals: _emptyTotals() };
    return;
  }
  if (!Array.isArray(loan.ledger.entries)) loan.ledger.entries = [];
  if (!loan.ledger.totals) loan.ledger.totals = _emptyTotals();
}

function _emptyTotals() {
  return {
    principalDue:     0,
    interestDue:      0,
    cashReceived:     0,
    waivedAmount:     0,
    adjustmentAmount: 0
  };
}

// ── Post entry ────────────────────────────────────────────────────────────────

/**
 * Append a ledger entry and update running totals.
 *
 * @param {Object} loan
 * @param {string} type    — one of ENTRY_TYPES
 * @param {number} amount  — always positive; direction implied by type
 * @param {string} [date]  — ISO date string; defaults to now
 * @param {string} [actor] — who/what originated this entry
 * @param {string} [ref]   — optional external reference (transaction id, etc.)
 * @returns {Object} the created entry
 */
function postEntry(loan, type, amount, date, actor, ref) {
  initLedgerIfNeeded(loan);

  var entry = {
    id:     'led-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5),
    type:   type,
    amount: +Math.abs(amount).toFixed(2),
    date:   date  || new Date().toISOString(),
    actor:  actor || 'system',
    ref:    ref   || null
  };

  loan.ledger.entries.push(entry);

  var t = loan.ledger.totals;
  switch (type) {
    case ENTRY_TYPES.PRINCIPAL_DUE:  t.principalDue     = +( t.principalDue     + entry.amount).toFixed(2); break;
    case ENTRY_TYPES.INTEREST_DUE:   t.interestDue      = +( t.interestDue      + entry.amount).toFixed(2); break;
    case ENTRY_TYPES.CASH_RECEIVED:  t.cashReceived     = +( t.cashReceived     + entry.amount).toFixed(2); break;
    case ENTRY_TYPES.WAIVED:         t.waivedAmount     = +( t.waivedAmount     + entry.amount).toFixed(2); break;
    case ENTRY_TYPES.ADJUSTMENT:     t.adjustmentAmount = +( t.adjustmentAmount + entry.amount).toFixed(2); break;
    case ENTRY_TYPES.REVERSAL:       t.cashReceived     = +Math.max(0, t.cashReceived - entry.amount).toFixed(2); break;
  }

  return entry;
}

// ── Balance query ─────────────────────────────────────────────────────────────

/**
 * Return a snapshot of the current ledger balance.
 * Returns zeroed totals for loans that have no ledger yet.
 *
 * @param {Object} loan
 * @returns {{ principalDue, interestDue, cashReceived, waivedAmount, adjustmentAmount, netDue }}
 */
function getBalance(loan) {
  var t = (loan.ledger && loan.ledger.totals) || _emptyTotals();
  var netDue = (t.principalDue + t.interestDue)
             - t.cashReceived
             - t.waivedAmount
             + t.adjustmentAmount;
  return {
    principalDue:     t.principalDue,
    interestDue:      t.interestDue,
    cashReceived:     t.cashReceived,
    waivedAmount:     t.waivedAmount,
    adjustmentAmount: t.adjustmentAmount,
    netDue:           +netDue.toFixed(2)
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  ENTRY_TYPES,
  initLedgerIfNeeded,
  postEntry,
  getBalance
};
