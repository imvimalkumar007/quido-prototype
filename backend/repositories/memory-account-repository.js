/**
 * MemoryAccountRepository
 *
 * In-memory implementation of AccountRepository.
 * Useful for:
 *  - Unit tests (no file system required)
 *  - Ephemeral dev sessions where persistence is not needed
 *
 * Data is lost when the process exits.
 */
'use strict';

const AccountRepository = require('./account-repository');

function MemoryAccountRepository() {
  this._store = Object.create(null); // { storageKey → account }
}

MemoryAccountRepository.prototype = Object.create(AccountRepository.prototype);
MemoryAccountRepository.prototype.constructor = MemoryAccountRepository;

MemoryAccountRepository.prototype.findByKey = function (storageKey) {
  var acct = this._store[storageKey];
  return acct ? JSON.parse(JSON.stringify(acct)) : null; // return a copy
};

MemoryAccountRepository.prototype.save = function (account) {
  if (!account || !account.storageKey) {
    throw new Error('MemoryAccountRepository.save — account must have a storageKey');
  }
  this._store[account.storageKey] = JSON.parse(JSON.stringify(account));
  return account;
};

MemoryAccountRepository.prototype.listAll = function () {
  return Object.values(this._store).map(function (a) {
    return JSON.parse(JSON.stringify(a));
  });
};

MemoryAccountRepository.prototype.delete = function (storageKey) {
  if (!this._store[storageKey]) return false;
  delete this._store[storageKey];
  return true;
};

module.exports = { MemoryAccountRepository };
