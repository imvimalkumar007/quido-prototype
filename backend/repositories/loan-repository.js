/**
 * LoanRepository — abstract interface
 *
 * Owns loan objects: core terms, status engine state, summary, arrangements,
 * servicing adjustments, and ops data.
 *
 * In a relational database this maps to a `loans` table (one row per loan),
 * with sub-tables for arrangements, adjustments, and ops data.
 * In the prototype it reads/writes the loans[] array inside the monolithic
 * account JSON document.
 *
 * Implemented by:
 *   FileDomainStore   — JSON file per account (default)
 *   MemoryDomainStore — in-memory Map (tests)
 */
'use strict';

function LoanRepository() {}

/**
 * Return the currently active loan, or null if none.
 * @param  {string} storageKey
 * @returns {Object|null} v3 loan object
 */
LoanRepository.prototype.getActiveLoan = function (storageKey) {
  throw new Error('LoanRepository.getActiveLoan — not implemented');
};

/**
 * Return a specific loan by loanId, or null if not found.
 * @param  {string} storageKey
 * @param  {string} loanId
 * @returns {Object|null}
 */
LoanRepository.prototype.getLoan = function (storageKey, loanId) {
  throw new Error('LoanRepository.getLoan — not implemented');
};

/**
 * Return all loans for a customer (active and historical).
 * @param  {string} storageKey
 * @returns {Object[]}
 */
LoanRepository.prototype.listLoans = function (storageKey) {
  throw new Error('LoanRepository.listLoans — not implemented');
};

/**
 * Persist a loan object (create or overwrite by loanId).
 * @param  {string} storageKey
 * @param  {Object} loan — full v3 loan object (must have .loanId)
 */
LoanRepository.prototype.saveLoan = function (storageKey, loan) {
  throw new Error('LoanRepository.saveLoan — not implemented');
};

/**
 * Return the activeLoanId for an account.
 * @param  {string} storageKey
 * @returns {string|null}
 */
LoanRepository.prototype.getActiveLoanId = function (storageKey) {
  throw new Error('LoanRepository.getActiveLoanId — not implemented');
};

/**
 * Set which loan is the active loan for an account.
 * @param  {string} storageKey
 * @param  {string} loanId
 */
LoanRepository.prototype.setActiveLoanId = function (storageKey, loanId) {
  throw new Error('LoanRepository.setActiveLoanId — not implemented');
};

module.exports = LoanRepository;
