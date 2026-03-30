/**
 * MemoryDomainStore
 *
 * In-memory implementation of all Quido domain repository interfaces.
 * Implements the same method surface as FileDomainStore using a plain
 * in-memory Map.  Data is lost when the process exits.
 *
 * Implements:
 *   AccountRepository      — findByKey, save, listAll, delete
 *   CustomerRepository     — getProfile, saveProfileSection
 *   AffordabilityRepository — getAffordability, saveAffordabilityRaw
 *   PaymentDetailsRepository — getPaymentDetails, savePaymentDetails
 *   LoanRepository         — getActiveLoan, getLoan, listLoans, saveLoan,
 *                            getActiveLoanId, setActiveLoanId
 *   TransactionRepository  — listTransactions, addTransaction, getTransaction
 *   ScheduleRepository     — getSchedule, saveSchedule
 *
 * Use cases:
 *   - Unit tests (no file system required)
 *   - In-process integration tests
 *   - Ephemeral dev sessions
 */
'use strict';

const { recalcAffordabilityDerived } = require('../domain/factories');

function nowIso() { return new Date().toISOString(); }

function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

function mergeInto(target, src) {
  if (!src || typeof src !== 'object') return;
  Object.keys(src).forEach(function (k) { target[k] = src[k]; });
}

// ── Constructor ────────────────────────────────────────────────────────────

function MemoryDomainStore() {
  this._map = Object.create(null); // { storageKey → account }
}

// ── Internal helpers ───────────────────────────────────────────────────────

MemoryDomainStore.prototype._load = function (storageKey) {
  var acct = this._map[storageKey];
  return acct ? clone(acct) : null;
};

MemoryDomainStore.prototype._commit = function (account) {
  this._map[account.storageKey] = clone(account);
  return account;
};

MemoryDomainStore.prototype._findLoan = function (account, loanId) {
  var loans = account.loans || [];
  if (loanId) {
    for (var i = 0; i < loans.length; i++) {
      if (loans[i].loanId === loanId) return loans[i];
    }
  }
  for (var j = 0; j < loans.length; j++) {
    if (loans[j].loanId === account.activeLoanId) return loans[j];
  }
  return loans[0] || null;
};

// ── AccountRepository interface ────────────────────────────────────────────

MemoryDomainStore.prototype.findByKey = function (storageKey) {
  return this._load(storageKey);
};

MemoryDomainStore.prototype.save = function (account) {
  if (!account || !account.storageKey) {
    throw new Error('MemoryDomainStore.save — account must have a storageKey');
  }
  return this._commit(account);
};

MemoryDomainStore.prototype.listAll = function () {
  return Object.values(this._map).map(clone);
};

MemoryDomainStore.prototype.delete = function (storageKey) {
  if (!this._map[storageKey]) return false;
  delete this._map[storageKey];
  return true;
};

// ── CustomerRepository interface ───────────────────────────────────────────

MemoryDomainStore.prototype.getProfile = function (storageKey) {
  var account = this._load(storageKey);
  return account ? (account.profile || {}) : null;
};

MemoryDomainStore.prototype.saveProfileSection = function (storageKey, section, fields) {
  var account = this._load(storageKey);
  if (!account) return;
  if (!account.profile)          account.profile = {};
  if (!account.profile[section]) account.profile[section] = {};
  mergeInto(account.profile[section], fields);
  account.updatedAt = nowIso();
  this._commit(account);
};

// ── AffordabilityRepository interface ─────────────────────────────────────

MemoryDomainStore.prototype.getAffordability = function (storageKey) {
  var account = this._load(storageKey);
  return account ? (account.affordability || {}) : null;
};

MemoryDomainStore.prototype.saveAffordabilityRaw = function (storageKey, rawFields) {
  var account = this._load(storageKey);
  if (!account) return;
  if (!account.affordability) {
    account.affordability = { incomeExpenditure: { raw: {}, derived: {} } };
  }
  var ie = account.affordability.incomeExpenditure;
  if (!ie.raw)     ie.raw     = {};
  if (!ie.derived) ie.derived = {};
  mergeInto(ie.raw, rawFields);
  recalcAffordabilityDerived(account);
  account.updatedAt = nowIso();
  this._commit(account);
};

// ── PaymentDetailsRepository interface ────────────────────────────────────

MemoryDomainStore.prototype.getPaymentDetails = function (storageKey) {
  var account = this._load(storageKey);
  return account ? (account.paymentDetails || {}) : null;
};

MemoryDomainStore.prototype.savePaymentDetails = function (storageKey, fields) {
  var account = this._load(storageKey);
  if (!account) return;
  if (!account.paymentDetails)      account.paymentDetails = {};
  if (!account.paymentDetails.card) account.paymentDetails.card = {};
  if (!account.paymentDetails.bank) account.paymentDetails.bank = {};
  if (fields.card) mergeInto(account.paymentDetails.card, fields.card);
  if (fields.bank) mergeInto(account.paymentDetails.bank, fields.bank);
  account.updatedAt = nowIso();
  this._commit(account);
};

// ── LoanRepository interface ───────────────────────────────────────────────

MemoryDomainStore.prototype.getActiveLoan = function (storageKey) {
  var account = this._load(storageKey);
  if (!account) return null;
  return this._findLoan(account, account.activeLoanId);
};

MemoryDomainStore.prototype.getLoan = function (storageKey, loanId) {
  var account = this._load(storageKey);
  if (!account) return null;
  return this._findLoan(account, loanId);
};

MemoryDomainStore.prototype.listLoans = function (storageKey) {
  var account = this._load(storageKey);
  return account ? clone(account.loans || []) : [];
};

MemoryDomainStore.prototype.saveLoan = function (storageKey, loan) {
  var account = this._load(storageKey);
  if (!account) return;
  if (!Array.isArray(account.loans)) account.loans = [];
  var replaced = false;
  for (var i = 0; i < account.loans.length; i++) {
    if (account.loans[i].loanId === loan.loanId) {
      account.loans[i] = loan;
      replaced = true;
      break;
    }
  }
  if (!replaced) account.loans.push(loan);
  account.updatedAt = nowIso();
  this._commit(account);
};

MemoryDomainStore.prototype.getActiveLoanId = function (storageKey) {
  var account = this._load(storageKey);
  return account ? (account.activeLoanId || null) : null;
};

MemoryDomainStore.prototype.setActiveLoanId = function (storageKey, loanId) {
  var account = this._load(storageKey);
  if (!account) return;
  account.activeLoanId = loanId;
  account.updatedAt = nowIso();
  this._commit(account);
};

// ── TransactionRepository interface ───────────────────────────────────────

MemoryDomainStore.prototype.listTransactions = function (storageKey, loanId) {
  var account = this._load(storageKey);
  if (!account) return [];
  var loan = this._findLoan(account, loanId);
  return loan ? clone(loan.transactions || []) : [];
};

MemoryDomainStore.prototype.addTransaction = function (storageKey, loanId, transaction) {
  var account = this._load(storageKey);
  if (!account) return null;
  var loan = this._findLoan(account, loanId);
  if (!loan) return null;
  if (!Array.isArray(loan.transactions)) loan.transactions = [];
  loan.transactions.push(transaction);
  account.updatedAt = nowIso();
  this._commit(account);
  return clone(transaction);
};

MemoryDomainStore.prototype.getTransaction = function (storageKey, loanId, txnId) {
  var txns = this.listTransactions(storageKey, loanId);
  for (var i = 0; i < txns.length; i++) {
    if (txns[i].id === txnId) return txns[i];
  }
  return null;
};

// ── ScheduleRepository interface ───────────────────────────────────────────

MemoryDomainStore.prototype.getSchedule = function (storageKey, loanId) {
  var account = this._load(storageKey);
  if (!account) return [];
  var loan = this._findLoan(account, loanId);
  return loan ? clone(loan.scheduleSnapshot || []) : [];
};

MemoryDomainStore.prototype.saveSchedule = function (storageKey, loanId, rows) {
  var account = this._load(storageKey);
  if (!account) return;
  var loan = this._findLoan(account, loanId);
  if (!loan) return;
  loan.scheduleSnapshot = clone(rows || []);
  account.updatedAt = nowIso();
  this._commit(account);
};

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = { MemoryDomainStore };
