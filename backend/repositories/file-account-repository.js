/**
 * FileAccountRepository
 *
 * Persists each v3 customerAccount as a single JSON file:
 *   {dbDir}/{storageKey}.json
 *
 * This is the default repository for the NovaPay prototype.
 * To migrate to a real database, implement the same interface in a new
 * repository (e.g. MongoAccountRepository, PostgresAccountRepository)
 * and swap it in server.js.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const AccountRepository = require('./account-repository');

/**
 * @param {string} dbDir — absolute path to the directory where JSON files live.
 *   Created automatically if it does not exist.
 */
function FileAccountRepository(dbDir) {
  this.dbDir = dbDir;
  // Ensure the storage directory exists on startup
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
}

FileAccountRepository.prototype = Object.create(AccountRepository.prototype);
FileAccountRepository.prototype.constructor = FileAccountRepository;

FileAccountRepository.prototype._filePath = function (storageKey) {
  // Sanitise key: only allow alphanumeric, hyphens, underscores
  var safe = String(storageKey).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(this.dbDir, safe + '.json');
};

FileAccountRepository.prototype.findByKey = function (storageKey) {
  var filePath = this._filePath(storageKey);
  if (!fs.existsSync(filePath)) return null;
  try {
    var raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[FileAccountRepository] Error reading', filePath, err.message);
    return null;
  }
};

FileAccountRepository.prototype.save = function (account) {
  if (!account || !account.storageKey) {
    throw new Error('FileAccountRepository.save — account must have a storageKey');
  }
  var filePath = this._filePath(account.storageKey);
  try {
    fs.writeFileSync(filePath, JSON.stringify(account, null, 2), 'utf8');
  } catch (err) {
    console.error('[FileAccountRepository] Error writing', filePath, err.message);
    throw err;
  }
  return account;
};

FileAccountRepository.prototype.listAll = function () {
  var results = [];
  try {
    var files = fs.readdirSync(this.dbDir);
    for (var i = 0; i < files.length; i++) {
      if (!files[i].endsWith('.json')) continue;
      var filePath = path.join(this.dbDir, files[i]);
      try {
        var raw  = fs.readFileSync(filePath, 'utf8');
        var acct = JSON.parse(raw);
        results.push(acct);
      } catch (e) {
        console.warn('[FileAccountRepository] Skipping unreadable file:', files[i]);
      }
    }
  } catch (err) {
    console.error('[FileAccountRepository] listAll error:', err.message);
  }
  return results;
};

FileAccountRepository.prototype.delete = function (storageKey) {
  var filePath = this._filePath(storageKey);
  if (!fs.existsSync(filePath)) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    console.error('[FileAccountRepository] Error deleting', filePath, err.message);
    return false;
  }
};

module.exports = { FileAccountRepository };
