/**
 * CustomerRepository — abstract interface
 *
 * Owns customer identity fields: profile (personal, employment, contact).
 *
 * In a relational database this maps to a `customers` table.
 * In the prototype it reads/writes the profile sub-document inside the
 * monolithic account JSON document.
 *
 * Implemented by:
 *   FileDomainStore   — JSON file per account (default)
 *   MemoryDomainStore — in-memory Map (tests)
 */
'use strict';

function CustomerRepository() {}

/**
 * Return the full profile sub-document for a customer.
 * @param  {string} storageKey
 * @returns {{ personal: Object, employment: Object, contact: Object } | null}
 */
CustomerRepository.prototype.getProfile = function (storageKey) {
  throw new Error('CustomerRepository.getProfile — not implemented');
};

/**
 * Merge fields into one section of the customer profile.
 * @param  {string} storageKey
 * @param  {'personal'|'employment'|'contact'} section
 * @param  {Object} fields — partial fields to merge in
 */
CustomerRepository.prototype.saveProfileSection = function (storageKey, section, fields) {
  throw new Error('CustomerRepository.saveProfileSection — not implemented');
};

module.exports = CustomerRepository;
