'use strict';

const { buildSchedule } = require('../domain/loan-engine');

const FIXED_APR = 29.9;
const MIN_AMOUNT = 300;
const MAX_AMOUNT = 10000;
const MIN_TERM = 6;
const MAX_TERM = 24;

function toNumber(v) {
  return Number(String(v || '0').replace(/[^0-9.]/g, '')) || 0;
}

function ageFromDob(dob, now) {
  if (!dob) return 0;
  var birth = new Date(dob);
  if (isNaN(birth.getTime())) return 0;
  var today = now || new Date();
  var age = today.getFullYear() - birth.getFullYear();
  var monthDelta = today.getMonth() - birth.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < birth.getDate())) age--;
  return Math.max(0, age);
}

function affordability(monthlyIncome, housingCosts, livingCosts, transportCosts, otherDebts) {
  var income = toNumber(monthlyIncome);
  var expenditure = toNumber(housingCosts) + toNumber(livingCosts) + toNumber(transportCosts) + toNumber(otherDebts);
  return {
    monthlyIncome: income,
    totalExpenditure: +expenditure.toFixed(2),
    disposableIncome: +(income - expenditure).toFixed(2)
  };
}

function buildQuote(amount, termMonths, apr) {
  var built = buildSchedule(amount, apr, termMonths, new Date().toISOString(), 0);
  return {
    amount: +amount.toFixed(2),
    termMonths: termMonths,
    apr: apr,
    emi: built.summary.emi,
    totalRepayable: built.summary.totalRepayable,
    totalInterest: built.summary.totalInterest
  };
}

function evaluateApplication(input) {
  var now = new Date();
  var reasons = [];
  var amount = toNumber(input.amount);
  var termMonths = parseInt(input.termMonths, 10) || 0;
  var aff = affordability(
    input.monthlyIncome,
    input.housingCosts,
    input.livingCosts,
    input.transportCosts,
    input.otherDebts
  );
  var age = ageFromDob(input.dob, now);
  var quote = buildQuote(amount, termMonths, FIXED_APR);
  var proxies = input.proxyData || {};

  if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) reasons.push('Requested amount is outside product limits.');
  if (termMonths < MIN_TERM || termMonths > MAX_TERM) reasons.push('Requested term is outside product limits.');
  if (age < 18) reasons.push('Applicant must be over 18.');
  if (!input.ukResident) reasons.push('Applicant must be a UK resident.');
  if (!input.gainfullyEmployed) reasons.push('Applicant must be gainfully employed.');
  if (aff.disposableIncome <= 0) reasons.push('Disposable income must be positive.');
  if (quote.emi > aff.disposableIncome * 0.45) reasons.push('Requested repayment is not affordable against disposable income.');
  if (proxies.recentDefaults) reasons.push('Recent defaults are outside current policy.');
  if ((proxies.ccjCount || 0) > 0) reasons.push('Active CCJs are outside current policy.');
  if ((proxies.missedPaymentsLast6m || 0) >= 3) reasons.push('Recent missed-payment history is outside current policy.');
  if (!proxies.onElectoralRoll) reasons.push('Applicant must be on the electoral roll for this prototype.');

  var approved = reasons.length === 0;
  var riskScore = 100;
  if (!proxies.onElectoralRoll) riskScore -= 20;
  if ((proxies.missedPaymentsLast6m || 0) > 0) riskScore -= 10 * (proxies.missedPaymentsLast6m || 0);
  if ((proxies.monthsAtAddress || 0) < 12) riskScore -= 10;
  if (quote.emi > aff.disposableIncome * 0.35) riskScore -= 15;

  return {
    stage: approved ? 'approved_pending_signature' : 'declined',
    approved: approved,
    reasons: reasons,
    quote: quote,
    affordability: aff,
    riskScore: Math.max(0, riskScore),
    policy: {
      minAmount: MIN_AMOUNT,
      maxAmount: MAX_AMOUNT,
      minTermMonths: MIN_TERM,
      maxTermMonths: MAX_TERM,
      apr: FIXED_APR
    }
  };
}

module.exports = {
  FIXED_APR,
  MIN_AMOUNT,
  MAX_AMOUNT,
  MIN_TERM,
  MAX_TERM,
  affordability,
  buildQuote,
  evaluateApplication
};
