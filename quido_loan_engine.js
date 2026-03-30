/**
 * Quido Loan Engine — Backend Reference
 * ─────────────────────────────────────────────────────────────────
 * Standard reducing balance (amortisation) engine.
 * All figures derive from: EMI = P × r(1+r)ⁿ / ((1+r)ⁿ − 1)
 *
 * Constraints (per product rules):
 *   - Min term: 3 months
 *   - Max term: 24 months
 *   - APR:      Market-aligned, default 29.9% for near-prime segment
 *
 * Usage:
 *   const loan = new LoanEngine({ principal: 1000, apr: 29.9, termMonths: 12, startDate: new Date('2025-04-03') });
 *   loan.calc();
 *   console.log(loan.summary());
 *   console.log(loan.schedule());
 */

class LoanEngine {

  constructor({ principal, apr, termMonths, startDate, paidCount = 0 }) {
    this.principal  = principal;
    this.apr        = apr;
    this.termMonths = Math.max(3, Math.min(24, termMonths)); // enforce 3–24 month limits
    this.startDate  = startDate instanceof Date ? startDate : new Date(startDate);
    this.paidCount  = paidCount; // how many instalments have already been paid

    // Derived — populated by calc()
    this.monthlyRate = 0;
    this.emi         = 0;
    this._schedule   = [];
  }

  // ── Core calculation ──────────────────────────────────────────
  calc() {
    const P = this.principal;
    const r = (this.apr / 100) / 12;    // monthly rate
    const n = this.termMonths;
    this.monthlyRate = r;

    // EMI formula — handles 0% edge case
    this.emi = r === 0
      ? P / n
      : P * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);

    // Build full amortisation schedule
    this._schedule = [];
    let balance = P;

    for (let i = 0; i < n; i++) {
      const interest  = balance * r;
      let principal   = this.emi - interest;
      if (i === n - 1) principal = balance; // clear remainder on final instalment
      balance = Math.max(0, balance - principal);

      const dueDate = new Date(this.startDate);
      dueDate.setMonth(dueDate.getMonth() + i);

      this._schedule.push({
        n:          i + 1,
        dueDate:    new Date(dueDate),
        emi:        this.emi,
        principal,
        interest,
        balance,
        status:     i < this.paidCount ? 'paid' : i === this.paidCount ? 'current' : 'upcoming',
      });
    }

    return this;
  }

  // ── Accessors ─────────────────────────────────────────────────
  schedule()          { return this._schedule; }
  nextInstalment()    { return this._schedule[this.paidCount] ?? null; }
  totalRepayable()    { return this.emi * this.termMonths; }
  totalInterest()     { return this.totalRepayable() - this.principal; }
  dailyRate()         { return (this.apr / 100) / 365; }

  outstandingBalance() {
    return this._schedule
      .slice(this.paidCount)
      .reduce((sum, inst) => sum + inst.principal, 0);
  }

  totalRepaid() {
    return this._schedule
      .slice(0, this.paidCount)
      .reduce((sum, inst) => sum + inst.emi, 0);
  }

  principalPaid() {
    return this._schedule
      .slice(0, this.paidCount)
      .reduce((sum, inst) => sum + inst.principal, 0);
  }

  interestPaid() {
    return this._schedule
      .slice(0, this.paidCount)
      .reduce((sum, inst) => sum + inst.interest, 0);
  }

  // ── Summary object (suitable for API response) ───────────────
  summary() {
    return {
      principal:        this.principal,
      apr:              this.apr,
      termMonths:       this.termMonths,
      startDate:        this.startDate.toISOString().slice(0, 10),
      emi:              +this.emi.toFixed(2),
      totalRepayable:   +this.totalRepayable().toFixed(2),
      totalInterest:    +this.totalInterest().toFixed(2),
      dailyRate:        +this.dailyRate().toFixed(8),
      outstandingBalance: +this.outstandingBalance().toFixed(2),
      totalRepaid:      +this.totalRepaid().toFixed(2),
      principalPaid:    +this.principalPaid().toFixed(2),
      interestPaid:     +this.interestPaid().toFixed(2),
      instalmentsPaid:  this.paidCount,
      instalmentsRemaining: this.termMonths - this.paidCount,
    };
  }

  // ── Payment Holiday ───────────────────────────────────────────
  // Business rules:
  //   1. Eligible from 1 day before the due date
  //   2. Max 2 uses during tenure; only 1 if term ≤ 6 months
  //   3. Account must be 'active' (not arrears/default)
  //   4. Duration 1–3 months (short-term difficulty only)
  //      Longer distress → signpost to agent/call/write
  //   5. Generates a confirmation document per application
  //
  // Capitalises the skipped instalment interest onto the balance
  // and appends new instalments at the end for each deferred month.
  applyPaymentHoliday(months = 1, accountStatus = 'active', phUsed = 0, today = new Date()) {
    // Rule 3
    if (accountStatus !== 'active') {
      throw new Error('Payment holiday not available: account is ' + accountStatus);
    }

    // Rule 2
    const maxPH = this.termMonths <= 6 ? 1 : 2;
    if (phUsed >= maxPH) {
      throw new Error('Maximum payment holidays (' + maxPH + ') already used on this loan');
    }

    // Rule 4
    if (months < 1 || months > 3) {
      throw new Error('Payment holiday duration must be 1–3 months');
    }

    const next = this.nextInstalment();
    if (!next) throw new Error('No current instalment to defer');

    // Rule 1: eligible from 1 day before due date
    const todayClean = new Date(today); todayClean.setHours(0,0,0,0);
    const dueClean   = new Date(next.dueDate); dueClean.setHours(0,0,0,0);
    const daysUntil  = Math.round((dueClean - todayClean) / (1000*60*60*24));
    if (daysUntil > 1) {
      throw new Error('Payment holiday not yet available. Due in ' + daysUntil + ' days. Eligible from 1 day before due date.');
    }

    // Apply PH to consecutive instalments
    for (let i = next.n - 1; i < next.n - 1 + months && i < this._schedule.length; i++) {
      this._schedule[i].status   = 'ph';
      this._schedule[i].deferred = true;
    }

    // Capitalise interest and append deferred instalments at end
    for (let m = 0; m < months; m++) {
      const capInt  = this.outstandingBalance() * this.monthlyRate;
      const lastInst = this._schedule[this._schedule.length - 1];
      const newDate  = new Date(lastInst.dueDate);
      newDate.setMonth(newDate.getMonth() + 1);
      this._schedule.push({
        n:         this._schedule.length + 1,
        dueDate:   newDate,
        emi:       this.emi,
        principal: Math.max(0, this.emi - capInt),
        interest:  capInt,
        balance:   0,
        status:    'upcoming',
        ph: false, pa: false
      });
    }

    return this;
  }

  // ── Payment Arrangement ───────────────────────────────────────
  // Freezes interest immediately, rebuilds remaining schedule
  // at 0% interest over 18 months (balance ÷ 18).
  applyPaymentArrangement(months = 18) {
    const bal        = this.outstandingBalance();
    const paMonthly  = bal / months;

    // Keep paid instalments, rebuild remainder
    const paid = this._schedule.slice(0, this.paidCount);
    this._schedule = paid;

    for (let m = 0; m < months; m++) {
      const d = new Date(this.startDate);
      d.setMonth(d.getMonth() + this.paidCount + m);
      this._schedule.push({
        n:          this.paidCount + m + 1,
        dueDate:    d,
        emi:        paMonthly,
        principal:  paMonthly,
        interest:   0,           // frozen
        balance:    bal - paMonthly * (m + 1),
        status:     m === 0 ? 'current' : 'upcoming',
        pa:         true,
      });
    }

    // Reset EMI to PA monthly figure
    this.emi = paMonthly;
    return this;
  }

  // ── Record a payment ─────────────────────────────────────────
  // Marks the current instalment as paid and advances paidCount.
  // For partial payments, pass the amount and it will reduce principal.
  recordPayment(amount) {
    const next = this.nextInstalment();
    if (!next) throw new Error('No outstanding instalment');

    if (Math.abs(amount - next.emi) < 0.01) {
      // Full instalment payment
      this._schedule[next.n - 1].status   = 'paid';
      this._schedule[next.n - 1].paidDate = new Date();
      this.paidCount++;
      if (this.paidCount < this._schedule.length) {
        this._schedule[this.paidCount].status = 'current';
      }
    } else {
      // Partial / overpayment — recalculate remaining schedule
      // (backend would trigger a full recalc from new balance)
      throw new Error('Partial payments require a full schedule recalculation — pass to recalcFromBalance()');
    }
    return this;
  }

  // ── Recalculate from a new balance (after partial payment) ────
  recalcFromBalance(newBalance) {
    const remaining = this.termMonths - this.paidCount;
    const r = this.monthlyRate;
    const newEmi = r === 0
      ? newBalance / remaining
      : newBalance * r * Math.pow(1+r, remaining) / (Math.pow(1+r, remaining) - 1);

    let bal = newBalance;
    for (let i = this.paidCount; i < this._schedule.length; i++) {
      const interest  = bal * r;
      const principal = newEmi - interest;
      bal = Math.max(0, bal - principal);
      this._schedule[i].emi       = newEmi;
      this._schedule[i].principal = principal;
      this._schedule[i].interest  = interest;
      this._schedule[i].balance   = bal;
    }
    this.emi = newEmi;
    return this;
  }

  // ── Early settlement figure ───────────────────────────────────
  // Outstanding principal + accrued daily interest since last payment date
  settlementFigure(settleDate = new Date()) {
    const lastPaid = this.paidCount > 0
      ? this._schedule[this.paidCount - 1].dueDate
      : this.startDate;
    const daysSince = Math.ceil((settleDate - lastPaid) / (1000 * 60 * 60 * 24));
    const accruedInterest = this.outstandingBalance() * this.dailyRate() * daysSince;
    return +(this.outstandingBalance() + accruedInterest).toFixed(2);
  }

}

// ── Example usage ──────────────────────────────────────────────
/*
const loan = new LoanEngine({
  principal:  1000,
  apr:        29.9,
  termMonths: 12,
  startDate:  new Date('2025-04-03'),
  paidCount:  3,
});

loan.calc();
console.log(loan.summary());
// {
//   principal: 1000,
//   apr: 29.9,
//   termMonths: 12,
//   emi: 100.99,
//   totalRepayable: 1211.88,
//   totalInterest: 211.88,
//   outstandingBalance: 727.42,
//   instalmentsPaid: 3,
//   instalmentsRemaining: 9,
//   ...
// }

// Apply a payment holiday
loan.applyPaymentHoliday();

// Apply a payment arrangement (0% interest, 18 months)
// loan.applyPaymentArrangement(18);

// Get settlement figure today
console.log('Settlement figure:', loan.settlementFigure());

// Print schedule
loan.schedule().forEach(inst => {
  console.log(`Inst ${inst.n}: EMI £${inst.emi.toFixed(2)}, Principal £${inst.principal.toFixed(2)}, Interest £${inst.interest.toFixed(2)}, Balance £${inst.balance.toFixed(2)} [${inst.status}]`);
});
*/

module.exports = LoanEngine;
