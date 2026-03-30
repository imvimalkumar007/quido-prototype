/**
 * AccountRepository — abstract interface (documentation contract).
 *
 * Concrete implementations:
 *   FileAccountRepository   — JSON files in /db/accounts/  (default)
 *   MemoryAccountRepository — in-memory Map (tests / ephemeral dev)
 *
 * All methods are synchronous in the file and memory implementations.
 * Swap to async (Promise-returning) when wiring a real database driver.
 */
'use strict';

/**
 * @interface AccountRepository
 */
function AccountRepository() {}

/**
 * Find an account by its storageKey.
 * @param  {string} storageKey
 * @returns {Object|null} v3 customerAccount or null if not found
 */
AccountRepository.prototype.findByKey = function (storageKey) {
  throw new Error('AccountRepository.findByKey — not implemented');
};

/**
 * Persist an account.  Creates or overwrites the existing record.
 * @param  {Object} account — v3 customerAccount
 * @returns {Object} the saved account
 */
AccountRepository.prototype.save = function (account) {
  throw new Error('AccountRepository.save — not implemented');
};

/**
 * Return all accounts (used by the ops directory listing).
 * @returns {Object[]} array of v3 customerAccount objects
 */
AccountRepository.prototype.listAll = function () {
  throw new Error('AccountRepository.listAll — not implemented');
};

/**
 * Delete an account by storageKey.
 * @param  {string} storageKey
 * @returns {boolean} true if deleted, false if not found
 */
AccountRepository.prototype.delete = function (storageKey) {
  throw new Error('AccountRepository.delete — not implemented');
};

module.exports = AccountRepository;
