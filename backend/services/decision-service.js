'use strict';

const { buildSchedule } = require('../domain/loan-engine');

// ── Product limits ────────────────────────────────────────────────────────────
const MIN_AMOUNT = 300;
const MAX_AMOUNT = 10000;
const MIN_TERM   = 6;
const MAX_TERM   = 24;

// ── Policy thresholds ─────────────────────────────────────────────────────────
const MIN_MONTHLY_INCOME     = 600;   // £/month net
const MAX_LOAN_INCOME_RATIO  = 6;     // loan ≤ 6× monthly income
const MAX_AGE_AT_END_OF_TERM = 70;    // years old at loan maturity
const MIN_POST_EMI_RESIDUAL  = 150;   // £/month left after paying EMI
const MAX_EMI_TO_DISPOSABLE  = 0.45;  // EMI / disposable income hard cap
const MIN_EMPLOYMENT_MONTHS  = 3;     // must have been in role ≥ 3 months

// ── Fixed APR ─────────────────────────────────────────────────────────────────
const REP_APR = 29.9;   // single fixed rate applied to all approved loans

// ── Helpers ───────────────────────────────────────────────────────────────────

function toNumber(v) {
  return Number(String(v || '0').replace(/[^0-9.]/g, '')) || 0;
}

function ageFromDob(dob, now) {
  if (!dob) return 0;
  var birth = new Date(dob);
  if (isNaN(birth.getTime())) return 0;
  var today = now || new Date();
  var age = today.getFullYear() - birth.getFullYear();
  var md = today.getMonth() - birth.getMonth();
  if (md < 0 || (md === 0 && today.getDate() < birth.getDate())) age--;
  return Math.max(0, age);
}

// Handles both "YYYY-MM" (from type=month input) and "Month YYYY" (legacy text)
function monthsEmployed(employmentStart, now) {
  if (!employmentStart) return null;
  var today = now || new Date();
  var d;
  if (/^\d{4}-\d{2}$/.test(String(employmentStart).trim())) {
    var p = String(employmentStart).trim().split('-');
    d = new Date(+p[0], +p[1] - 1, 1);
  } else {
    d = new Date(employmentStart);
  }
  if (!d || isNaN(d.getTime())) return null;
  return Math.max(0, (today.getFullYear() - d.getFullYear()) * 12 + today.getMonth() - d.getMonth());
}

function calcAffordability(monthlyIncome, housingCosts, livingCosts, transportCosts, otherDebts) {
  var income      = toNumber(monthlyIncome);
  var expenditure = toNumber(housingCosts) + toNumber(livingCosts) + toNumber(transportCosts) + toNumber(otherDebts);
  return {
    monthlyIncome:    income,
    totalExpenditure: +expenditure.toFixed(2),
    disposableIncome: +(income - expenditure).toFixed(2),
  };
}

function buildQuote(amount, termMonths, apr) {
  var built = buildSchedule(amount, apr, termMonths, new Date().toISOString(), 0);
  return {
    amount:         +amount.toFixed(2),
    termMonths:     termMonths,
    apr:            apr,
    emi:            built.summary.emi,
    totalRepayable: built.summary.totalRepayable,
    totalInterest:  built.summary.totalInterest,
  };
}

// ── Risk scoring ──────────────────────────────────────────────────────────────
// Returns { score: number, breakdown: [{ factor, impact }] }
// Each factor documents what reduced the score and why.

function computeRiskScore(f) {
  var score     = 100;
  var breakdown = [];

  function deduct(pts, label) {
    score -= pts;
    breakdown.push({ factor: label, impact: -pts });
  }

  // Electoral roll
  if (!f.onElectoralRoll) deduct(25, 'Not registered on the electoral roll');

  // Missed payments in last 6 months
  var missed = Math.min(f.missedPaymentsLast6m || 0, 5);
  if (missed === 1) deduct(12, '1 missed payment in last 6 months');
  else if (missed === 2) deduct(24, '2 missed payments in last 6 months');
  else if (missed >= 3) deduct(36, missed + ' missed payments in last 6 months');

  // Address stability
  var addr = f.monthsAtAddress || 0;
  if (addr < 3)        deduct(25, 'Less than 3 months at current address');
  else if (addr < 12)  deduct(12, 'Less than 12 months at current address');

  // Employment tenure
  var emp = f.monthsEmployed;
  if (emp !== null && emp !== undefined) {
    if (emp < 6)       deduct(20, 'Less than 6 months in current role');
    else if (emp < 12) deduct(10, 'Less than 12 months in current role');
  }

  // Employment status risk premium
  var status = (f.employmentStatus || '').toLowerCase();
  if (status.indexOf('self-employed') > -1 || status.indexOf('contractor') > -1) {
    deduct(10, 'Income source is self-employed or contract-based');
  }

  // EMI affordability ratio
  var ratio = f.emiToDisposable || 0;
  if      (ratio > 0.40) deduct(20, 'Repayment exceeds 40% of disposable income');
  else if (ratio > 0.30) deduct(10, 'Repayment is between 30–40% of disposable income');

  // Post-EMI income buffer
  if (f.postEmiResidual < 300) deduct(10, 'Low income buffer remaining after repayment');

  return { score: Math.max(0, score), breakdown: breakdown };
}

// ── Main evaluation ───────────────────────────────────────────────────────────

function evaluateApplication(input) {
  var now        = new Date();
  var reasons    = [];
  var amount     = toNumber(input.amount);
  var termMonths = parseInt(input.termMonths, 10) || 0;
  var aff        = calcAffordability(
    input.monthlyIncome, input.housingCosts,
    input.livingCosts,   input.transportCosts,
    input.otherDebts
  );
  var age      = ageFromDob(input.dob, now);
  var proxies  = input.proxyData || {};
  var empMonths = monthsEmployed(input.employmentStart, now);

  // Use rep APR for all knockout threshold checks (conservative, customer-favourable)
  var referenceEMI     = (amount > 0 && termMonths > 0) ? buildQuote(amount, termMonths, REP_APR).emi : 0;
  var emiToDisposable  = aff.disposableIncome > 0 ? referenceEMI / aff.disposableIncome : 1;
  var postEmiResidual  = aff.disposableIncome - referenceEMI;

  // ── Knockout rules ────────────────────────────────────────────────────────
  function decline(msg) { reasons.push(msg); }

  if (amount < MIN_AMOUNT || amount > MAX_AMOUNT)
    decline('Requested amount must be between £' + MIN_AMOUNT + ' and £' + MAX_AMOUNT + '.');
  if (termMonths < MIN_TERM || termMonths > MAX_TERM)
    decline('Loan term must be between ' + MIN_TERM + ' and ' + MAX_TERM + ' months.');
  if (age > 0 && age < 18)
    decline('Applicant must be 18 or over.');
  if (age > 0 && (age + termMonths / 12) > MAX_AGE_AT_END_OF_TERM)
    decline('Age at the end of the loan term would exceed ' + MAX_AGE_AT_END_OF_TERM + '.');
  if (!input.ukResident)
    decline('Applicant must be a UK resident.');
  if (!input.gainfullyEmployed)
    decline('Applicant must be in gainful employment.');
  if (aff.monthlyIncome < MIN_MONTHLY_INCOME)
    decline('Monthly income does not meet the minimum threshold of £' + MIN_MONTHLY_INCOME + '.');
  if (aff.monthlyIncome > 0 && amount > aff.monthlyIncome * MAX_LOAN_INCOME_RATIO)
    decline('Requested amount exceeds ' + MAX_LOAN_INCOME_RATIO + '× monthly income.');
  if (aff.disposableIncome <= 0)
    decline('Disposable income must be positive after all declared commitments.');
  if (referenceEMI > 0 && emiToDisposable > MAX_EMI_TO_DISPOSABLE)
    decline('Monthly repayment would exceed ' + (MAX_EMI_TO_DISPOSABLE * 100) + '% of disposable income.');
  if (referenceEMI > 0 && postEmiResidual < MIN_POST_EMI_RESIDUAL)
    decline('Residual income after repayment would fall below £' + MIN_POST_EMI_RESIDUAL + ' per month.');
  if (proxies.recentDefaults)
    decline('Recent defaults are outside current lending policy.');
  if ((proxies.ccjCount || 0) > 0)
    decline('Active CCJs or defaults are outside current lending policy.');
  if ((proxies.missedPaymentsLast6m || 0) >= 3)
    decline('Three or more missed payments in the last 6 months exceed our policy threshold.');
  if (!proxies.onElectoralRoll)
    decline('Applicant must be registered on the electoral roll.');
  if (empMonths !== null && empMonths < MIN_EMPLOYMENT_MONTHS)
    decline('Minimum ' + MIN_EMPLOYMENT_MONTHS + ' months in current role is required to verify income stability.');

  // ── Risk scoring ──────────────────────────────────────────────────────────
  var scored = computeRiskScore({
    onElectoralRoll:      !!proxies.onElectoralRoll,
    missedPaymentsLast6m: proxies.missedPaymentsLast6m || 0,
    monthsAtAddress:      proxies.monthsAtAddress || 0,
    monthsEmployed:       empMonths,
    employmentStatus:     input.employmentStatus || '',
    emiToDisposable:      emiToDisposable,
    postEmiResidual:      postEmiResidual,
  });

  var approved = reasons.length === 0;
  var quote    = buildQuote(amount, termMonths, REP_APR);

  return {
    stage:          approved ? 'approved_pending_signature' : 'declined',
    approved:       approved,
    reasons:        reasons,
    quote:          quote,
    affordability:  aff,
    riskScore:      scored.score,
    scoreBreakdown: scored.breakdown,
    policy: {
      minAmount:      MIN_AMOUNT,
      maxAmount:      MAX_AMOUNT,
      minTermMonths:  MIN_TERM,
      maxTermMonths:  MAX_TERM,
      repAPR:         REP_APR,
    },
  };
}

module.exports = {
  FIXED_APR: REP_APR,
  REP_APR,
  MIN_AMOUNT,
  MAX_AMOUNT,
  MIN_TERM,
  MAX_TERM,
  calcAffordability,
  buildQuote,
  evaluateApplication,
};
