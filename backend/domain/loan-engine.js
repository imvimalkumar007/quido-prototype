/**
 * NovaPay Loan Engine — Node.js
 *
 * Reducing-balance EMI calculator and amortisation schedule builder.
 * Server-side equivalent of NovaPay.builtInEngineFactory in novapay-core.js.
 * Pure functions — no side-effects, no global state.
 *
 * Usage:
 *   const { buildSchedule, calcEmi } = require('./loan-engine');
 *   const { emi, schedule, summary } = buildSchedule(principal, apr, termMonths, startDate, paidCount);
 */
'use strict';

const BALANCE_TOLERANCE = 0.01;

/**
 * Calculate the monthly EMI for a reducing-balance loan.
 * @param {number} principal
 * @param {number} apr        – annual percentage rate (e.g. 29.9 for 29.9%)
 * @param {number} termMonths
 * @returns {number}
 */
function calcEmi(principal, apr, termMonths) {
  if (!principal || !termMonths) return 0;
  var r = (apr / 100) / 12;
  if (r === 0) return principal / termMonths;
  var factor = Math.pow(1 + r, termMonths);
  return (principal * r * factor) / (factor - 1);
}

/**
 * Add months to a Date, returning a new Date.
 * Uses the 1st of the month if the original day would overflow.
 */
function addMonths(date, n) {
  var d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

/**
 * Build the full amortisation schedule for a loan.
 *
 * @param {number} principal
 * @param {number} apr
 * @param {number} termMonths
 * @param {string|Date} startDate  – first payment date (ISO string or Date)
 * @param {number} [paidCount=0]   – how many instalments have already been paid
 * @returns {{ emi: number, schedule: Object[], summary: Object }}
 */
function buildSchedule(principal, apr, termMonths, startDate, paidCount) {
  paidCount = paidCount || 0;
  var emi  = calcEmi(principal, apr, termMonths);
  var r    = (apr / 100) / 12;
  var base = startDate ? new Date(startDate) : new Date();

  var rows       = [];
  var balance    = principal;
  var totalPaid  = 0;

  for (var n = 1; n <= termMonths; n++) {
    var interest  = balance * r;
    var princ     = emi - interest;
    // Last row: absorb rounding
    if (n === termMonths) {
      princ    = balance;
      interest = emi - princ;
      if (interest < 0) interest = 0;
    }
    balance  = Math.max(0, balance - princ);

    var status;
    if (n <= paidCount)   status = 'paid';
    else if (n === paidCount + 1) status = 'current';
    else status = 'upcoming';

    if (n <= paidCount) totalPaid += emi;

    rows.push({
      n:         n,
      dueDate:   addMonths(base, n - 1).toISOString(),
      emi:       +emi.toFixed(2),
      principal: +princ.toFixed(2),
      interest:  +interest.toFixed(2),
      balance:   +balance.toFixed(2),
      status:    status,
      ph:        false,
      pa:        false
    });
  }

  var outstandingBalance = rows
    .filter(function (r) { return r.status !== 'paid'; })
    .reduce(function (acc, r) { return acc + r.principal; }, 0);

  var instalmentsRemaining = rows.filter(function (r) { return r.status !== 'paid'; }).length;
  var totalRepayable       = emi * termMonths;
  var totalInterest        = totalRepayable - principal;

  var summary = {
    emi:                  +emi.toFixed(2),
    totalRepayable:       +totalRepayable.toFixed(2),
    totalInterest:        +totalInterest.toFixed(2),
    outstandingBalance:   +outstandingBalance.toFixed(2),
    totalRepaid:          +totalPaid.toFixed(2),
    instalmentsRemaining: instalmentsRemaining
  };

  return { emi: +emi.toFixed(2), schedule: rows, summary: summary };
}

/**
 * Derive the operative schedule from the stored snapshot.
 *
 * The operative schedule is the base schedule with PH and PA rows clearly
 * marked. It is what both UIs render to the customer and agent.
 *
 * Currently the snapshot already carries ph/pa flags set by the servicing
 * engine mutations. This function is a passthrough that guarantees defaults.
 *
 * @param {Object[]} snapshot
 * @returns {Object[]}
 */
function deriveOperativeSchedule(snapshot) {
  if (!Array.isArray(snapshot)) return [];
  return snapshot.map(function (row) {
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
 * Compute the outstanding balance from a schedule snapshot, accounting for
 * any partial credit accumulated towards the next instalment.
 *
 * @param {Object[]} snapshot
 * @param {number}   paidCount
 * @param {number}   [partialCredit=0]
 * @returns {number}
 */
function computeOutstandingBalance(snapshot, paidCount, partialCredit) {
  if (!Array.isArray(snapshot) || !snapshot.length) return 0;
  var bal = snapshot
    .slice(paidCount)
    .filter(function (r) { return !r.ph; })
    .reduce(function (acc, r) { return acc + (r.principal || 0); }, 0);
  return Math.max(0, bal - (partialCredit || 0));
}

module.exports = {
  calcEmi,
  buildSchedule,
  deriveOperativeSchedule,
  computeOutstandingBalance,
  BALANCE_TOLERANCE
};
