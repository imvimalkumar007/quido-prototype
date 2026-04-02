'use strict';

const { createEmptyLoan } = require('../domain/factories');
const { buildSchedule } = require('../domain/loan-engine');
const { runStatusEngine } = require('../domain/status-engine');

function nowIso() { return new Date().toISOString(); }
function nextMonthIso(fromDate) {
  var d = fromDate ? new Date(fromDate) : new Date();
  d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

function generateLoanId(account) {
  var existing = {};
  (account.loans || []).forEach(function (loan) { existing[loan.loanId] = true; });
  var candidate = '';
  do {
    candidate = String(10000 + Math.floor(Math.random() * 90000));
  } while (existing[candidate]);
  return candidate;
}

function disburseApprovedApplication(account, actor) {
  var app = account.application || {};
  if (!app.decision || !app.decision.approved) {
    var err = new Error('Application is not approved.');
    err.status = 422;
    throw err;
  }
  if (!app.signedAt) {
    var signErr = new Error('Application documents must be signed before disbursal.');
    signErr.status = 422;
    throw signErr;
  }
  if (app.disbursal && app.disbursal.disbursedAt) {
    return account;
  }

  var quote = app.quote || {};
  var loanId = generateLoanId(account);
  var loan = createEmptyLoan(loanId);
  var disbursedAt = nowIso();
  var firstDueDate = nextMonthIso(disbursedAt);
  var built = buildSchedule(quote.amount || 0, quote.apr || 29.9, quote.termMonths || 12, firstDueDate, 0);

  loan.originatedAt = disbursedAt;
  loan.loanCore = {
    principal: quote.amount || 0,
    apr: quote.apr || 29.9,
    termMonths: quote.termMonths || 12,
    startDate: firstDueDate,
    paidCount: 0
  };
  loan.scheduleSnapshot = built.schedule.map(function (row) {
    return {
      n: row.n,
      dueDate: row.dueDate,
      emi: row.emi,
      principal: row.principal,
      interest: row.interest,
      balance: row.balance,
      status: row.status,
      ph: false,
      pa: false,
      interestPaid: 0,
      principalPaid: 0,
      interestRemaining: row.interest,
      principalRemaining: row.principal,
      remainingDue: row.emi
    };
  });
  loan.loanSummary = {
    emi: built.summary.emi,
    totalRepayable: built.summary.totalRepayable,
    totalInterest: built.summary.totalInterest,
    outstandingBalance: built.summary.outstandingBalance,
    totalRepaid: 0,
    totalInterestPaid: 0,
    totalPrincipalPaid: 0,
    instalmentsRemaining: built.summary.instalmentsRemaining
  };
  runStatusEngine(loan, new Date());
  loan.auditTrail.push({
    id: 'loan-disbursed-' + Date.now(),
    action: 'loan_disbursed',
    payload: {
      amount: quote.amount || 0,
      termMonths: quote.termMonths || 12,
      apr: quote.apr || 29.9
    },
    source: actor || 'ops_ui',
    timestamp: disbursedAt
  });

  account.loans = account.loans || [];
  account.loans.push(loan);
  account.activeLoanId = loanId;
  account.auth.portalEnabled = true;
  account.profile.personal.memberSince = account.profile.personal.memberSince || new Date().toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  app.stage = 'disbursed';
  app.disbursal = {
    status: 'disbursed',
    approvedAt: disbursedAt,
    approvedBy: actor || 'ops_ui',
    disbursedAt: disbursedAt,
    disbursedBy: actor || 'ops_ui'
  };
  app.statusHistory = app.statusHistory || [];
  app.statusHistory.push({ stage: 'disbursed', at: disbursedAt, by: actor || 'ops_ui' });
  return account;
}

module.exports = {
  disburseApprovedApplication
};
