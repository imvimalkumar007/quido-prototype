/**
 * TransactionRepository — abstract interface
 *
 * Owns payment transaction records for a loan.
 * Each transaction is an immutable record of a payment attempt or event.
 *
 * In a relational database this maps to a `transactions` table keyed on
 * (loan_id, transaction_id).  Transactions are append-only: they are never
 * updated or deleted once written.
 * In the prototype it reads/writes the loan.transactions array inside the
 * monolithic account JSON document.
 *
 * Implemented by:
 *   FileDomainStore   — JSON file per account (default)
 *   MemoryDomainStore — in-memory Map (tests)
 */
'use strict';

function TransactionRepository() {}

/**
 * Return all transactions for a loan, in chronological order.
 * @param  {string} storageKey
 * @param  {string} loanId
 * @returns {Object[]}
 */
TransactionRepository.prototype.listTransactions = function (storageKey, loanId) {
  throw new Error('TransactionRepository.listTransactions — not implemented');
};

/**
 * Append a new transaction record to a loan's transaction log.
 * @param  {string} storageKey
 * @param  {string} loanId
 * @param  {Object} transaction — { id, type, amount, date, successful, actor }
 * @returns {Object} the saved transaction
 */
TransactionRepository.prototype.addTransaction = function (storageKey, loanId, transaction) {
  throw new Error('TransactionRepository.addTransaction — not implemented');
};

/**
 * Return a single transaction by id, or null if not found.
 * @param  {string} storageKey
 * @param  {string} loanId
 * @param  {string} txnId
 * @returns {Object|null}
 */
TransactionRepository.prototype.getTransaction = function (storageKey, loanId, txnId) {
  throw new Error('TransactionRepository.getTransaction — not implemented');
};

module.exports = TransactionRepository;
