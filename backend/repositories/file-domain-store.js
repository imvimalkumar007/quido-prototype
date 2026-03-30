/**
 * FileDomainStore
 *
 * A single concrete class that implements all NovaPay domain repository
 * interfaces by reading and writing one JSON file per customer account:
 *   {dbDir}/{storageKey}.json
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
 * Design rationale (document store adapter):
 *   All domain interfaces read from / write to sub-documents within the
 *   canonical v3 customerAccount blob.  Every targeted write method
 *   (e.g. saveProfileSection) performs one load → patch → save cycle
 *   internally.  This is correct behaviour for a document database.
 *   For a relational database, replace FileDomainStore with a
 *   PostgresDomainStore that issues targeted UPDATE statements per method —
 *   the AccountService interface does not change.
 *
 * Migration path to a real database:
 *   1. Implement PostgresDomainStore (or MongoDomainStore) with the same
 *      method signatures as this class.
 *   2. In server.js, swap:
 *        const store = new FileDomainStore(DB_DIR);
 *      for:
 *        const store = new PostgresDomainStore(connectionString);
 *   3. AccountService and all route handlers require zero changes.
 */
'use strict';

const { FileAccountRepository } = require('./file-account-repository');
const { recalcAffordabilityDerived } = require('../domain/factories');

function nowIso() { return new Date().toISOString(); }

function mergeInto(target, src) {
  if (!src || typeof src !== 'object') return;
  Object.keys(src).forEach(function (k) { target[k] = src[k]; });
}

// ── Constructor ────────────────────────────────────────────────────────────

/**
 * @param {string} dbDir — absolute path to the JSON file directory.
 *   Created automatically if it does not exist.
 */
function FileDomainStore(dbDir) {
  this._repo = new FileAccountRepository(dbDir);
}

// ── Internal helpers ───────────────────────────────────────────────────────

FileDomainStore.prototype._load = function (storageKey) {
  return this._repo.findByKey(storageKey);
};

FileDomainStore.prototype._save = function (account) {
  return this._repo.save(account);
};

/** Find a loan by loanId within an account object (already loaded). */
FileDomainStore.prototype._findLoan = function (account, loanId) {
  var loans = account.loans || [];
  if (loanId) {
    for (var i = 0; i < loans.length; i++) {
      if (loans[i].loanId === loanId) return loans[i];
    }
  }
  // Fall back to active loan
  for (var j = 0; j < loans.length; j++) {
    if (loans[j].loanId === account.activeLoanId) return loans[j];
  }
  return loans[0] || null;
};

// ── AccountRepository interface ────────────────────────────────────────────

/**
 * Return the full v3 customerAccount for a storageKey, or null.
 */
FileDomainStore.prototype.findByKey = function (storageKey) {
  return this._repo.findByKey(storageKey);
};

/**
 * Persist a full v3 customerAccount (create or overwrite).
 */
FileDomainStore.prototype.save = function (account) {
  return this._repo.save(account);
};

/**
 * Return all accounts (used by the ops directory listing).
 */
FileDomainStore.prototype.listAll = function () {
  return this._repo.listAll();
};

/**
 * Delete an account by storageKey.
 */
FileDomainStore.prototype.delete = function (storageKey) {
  return this._repo.delete(storageKey);
};

// ── CustomerRepository interface ───────────────────────────────────────────

/**
 * Return the profile sub-document (personal, employment, contact sections).
 * Maps to: SELECT * FROM customers WHERE storage_key = $1
 */
FileDomainStore.prototype.getProfile = function (storageKey) {
  var account = this._load(storageKey);
  return account ? (account.profile || {}) : null;
};

/**
 * Merge fields into one profile section and persist.
 * Maps to: UPDATE customers SET {section}_fields = $2 WHERE storage_key = $1
 * @param {'personal'|'employment'|'contact'} section
 */
FileDomainStore.prototype.saveProfileSection = function (storageKey, section, fields) {
  var account = this._load(storageKey);
  if (!account) return;
  if (!account.profile)          account.profile = {};
  if (!account.profile[section]) account.profile[section] = {};
  mergeInto(account.profile[section], fields);
  account.updatedAt = nowIso();
  this._save(account);
};

// ── AffordabilityRepository interface ─────────────────────────────────────

/**
 * Return the affordability sub-document.
 * Maps to: SELECT * FROM affordability_assessments WHERE storage_key = $1
 */
FileDomainStore.prototype.getAffordability = function (storageKey) {
  var account = this._load(storageKey);
  return account ? (account.affordability || {}) : null;
};

/**
 * Merge raw input fields into incomeExpenditure.raw and recompute derived.
 * Maps to:
 *   UPDATE affordability_assessments
 *   SET monthly_income = $2, housing_costs = $3, ...
 *   WHERE storage_key = $1
 */
FileDomainStore.prototype.saveAffordabilityRaw = function (storageKey, rawFields) {
  var account = this._load(storageKey);
  if (!account) return;
  if (!account.affordability) {
    account.affordability = { incomeExpenditure: { raw: {}, derived: {} } };
  }
  var ie = account.affordability.incomeExpenditure;
  if (!ie.raw)     ie.raw     = {};
  if (!ie.derived) ie.derived = {};
  mergeInto(ie.raw, rawFields);
  recalcAffordabilityDerived(account); // recomputes ie.derived in-place
  account.updatedAt = nowIso();
  this._save(account);
};

// ── PaymentDetailsRepository interface ────────────────────────────────────

/**
 * Return the paymentDetails sub-document.
 * Maps to: SELECT * FROM payment_methods WHERE customer_id = $1
 */
FileDomainStore.prototype.getPaymentDetails = function (storageKey) {
  var account = this._load(storageKey);
  return account ? (account.paymentDetails || {}) : null;
};

/**
 * Merge updated payment method fields and persist.
 * Maps to:
 *   INSERT INTO payment_methods ... ON CONFLICT (customer_id, type) DO UPDATE SET ...
 */
FileDomainStore.prototype.savePaymentDetails = function (storageKey, fields) {
  var account = this._load(storageKey);
  if (!account) return;
  if (!account.paymentDetails)      account.paymentDetails = {};
  if (!account.paymentDetails.card) account.paymentDetails.card = {};
  if (!account.paymentDetails.bank) account.paymentDetails.bank = {};
  if (fields.card) mergeInto(account.paymentDetails.card, fields.card);
  if (fields.bank) mergeInto(account.paymentDetails.bank, fields.bank);
  account.updatedAt = nowIso();
  this._save(account);
};

// ── LoanRepository interface ───────────────────────────────────────────────

/**
 * Return the active loan object, or null if none.
 * Maps to:
 *   SELECT l.* FROM loans l
 *   JOIN accounts a ON l.loan_id = a.active_loan_id
 *   WHERE a.storage_key = $1
 */
FileDomainStore.prototype.getActiveLoan = function (storageKey) {
  var account = this._load(storageKey);
  if (!account) return null;
  return this._findLoan(account, account.activeLoanId);
};

/**
 * Return a loan by loanId, or null.
 * Maps to: SELECT * FROM loans WHERE loan_id = $1
 */
FileDomainStore.prototype.getLoan = function (storageKey, loanId) {
  var account = this._load(storageKey);
  if (!account) return null;
  return this._findLoan(account, loanId);
};

/**
 * Return all loans for a customer (active and historical).
 * Maps to: SELECT * FROM loans WHERE storage_key = $1 ORDER BY originated_at
 */
FileDomainStore.prototype.listLoans = function (storageKey) {
  var account = this._load(storageKey);
  return account ? (account.loans || []) : [];
};

/**
 * Create or overwrite a loan record (matched by loanId).
 * Maps to:
 *   INSERT INTO loans (loan_id, storage_key, ...) VALUES (...)
 *   ON CONFLICT (loan_id) DO UPDATE SET ...
 */
FileDomainStore.prototype.saveLoan = function (storageKey, loan) {
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
  this._save(account);
};

/**
 * Return the activeLoanId for an account.
 * Maps to: SELECT active_loan_id FROM accounts WHERE storage_key = $1
 */
FileDomainStore.prototype.getActiveLoanId = function (storageKey) {
  var account = this._load(storageKey);
  return account ? (account.activeLoanId || null) : null;
};

/**
 * Set which loan is considered active for an account.
 * Maps to: UPDATE accounts SET active_loan_id = $2 WHERE storage_key = $1
 */
FileDomainStore.prototype.setActiveLoanId = function (storageKey, loanId) {
  var account = this._load(storageKey);
  if (!account) return;
  account.activeLoanId = loanId;
  account.updatedAt = nowIso();
  this._save(account);
};

// ── TransactionRepository interface ───────────────────────────────────────

/**
 * Return all transactions for a loan in chronological order.
 * Maps to:
 *   SELECT * FROM transactions WHERE loan_id = $1 ORDER BY date ASC
 */
FileDomainStore.prototype.listTransactions = function (storageKey, loanId) {
  var account = this._load(storageKey);
  if (!account) return [];
  var loan = this._findLoan(account, loanId);
  return loan ? (loan.transactions || []) : [];
};

/**
 * Append a transaction to a loan's transaction log.
 * Maps to:
 *   INSERT INTO transactions (id, loan_id, type, amount, date, ...)
 *   VALUES ($1, $2, $3, $4, $5, ...)
 */
FileDomainStore.prototype.addTransaction = function (storageKey, loanId, transaction) {
  var account = this._load(storageKey);
  if (!account) return null;
  var loan = this._findLoan(account, loanId);
  if (!loan) return null;
  if (!Array.isArray(loan.transactions)) loan.transactions = [];
  loan.transactions.push(transaction);
  account.updatedAt = nowIso();
  this._save(account);
  return transaction;
};

/**
 * Return a single transaction by id, or null.
 * Maps to:
 *   SELECT * FROM transactions WHERE loan_id = $1 AND id = $2
 */
FileDomainStore.prototype.getTransaction = function (storageKey, loanId, txnId) {
  var txns = this.listTransactions(storageKey, loanId);
  for (var i = 0; i < txns.length; i++) {
    if (txns[i].id === txnId) return txns[i];
  }
  return null;
};

// ── ScheduleRepository interface ───────────────────────────────────────────

/**
 * Return the schedule snapshot for a loan.
 * Maps to:
 *   SELECT * FROM schedule_rows WHERE loan_id = $1 ORDER BY n ASC
 */
FileDomainStore.prototype.getSchedule = function (storageKey, loanId) {
  var account = this._load(storageKey);
  if (!account) return [];
  var loan = this._findLoan(account, loanId);
  return loan ? (loan.scheduleSnapshot || []) : [];
};

/**
 * Replace the full schedule snapshot for a loan.
 * Maps to:
 *   DELETE FROM schedule_rows WHERE loan_id = $1;
 *   INSERT INTO schedule_rows (loan_id, n, due_date, emi, ...) VALUES ...
 */
FileDomainStore.prototype.saveSchedule = function (storageKey, loanId, rows) {
  var account = this._load(storageKey);
  if (!account) return;
  var loan = this._findLoan(account, loanId);
  if (!loan) return;
  loan.scheduleSnapshot = rows || [];
  account.updatedAt = nowIso();
  this._save(account);
};

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = { FileDomainStore };
