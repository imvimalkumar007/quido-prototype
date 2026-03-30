/**
 * AffordabilityRepository — abstract interface
 *
 * Owns the customer's affordability assessment:
 *   incomeExpenditure.raw    — as entered by the customer / ops
 *   incomeExpenditure.derived — computed fields (totalExpenditure, disposableIncome)
 *
 * In a relational database this maps to an `affordability_assessments` table.
 * In the prototype it reads/writes the affordability sub-document inside the
 * monolithic account JSON document.
 *
 * Implemented by:
 *   FileDomainStore   — JSON file per account (default)
 *   MemoryDomainStore — in-memory Map (tests)
 */
'use strict';

function AffordabilityRepository() {}

/**
 * Return the full affordability sub-document.
 * @param  {string} storageKey
 * @returns {{ incomeExpenditure: { raw: Object, derived: Object } } | null}
 */
AffordabilityRepository.prototype.getAffordability = function (storageKey) {
  throw new Error('AffordabilityRepository.getAffordability — not implemented');
};

/**
 * Merge raw input fields into incomeExpenditure.raw and recompute derived.
 * Implementations are responsible for calling the derived-field recalculation
 * after persisting raw fields.
 * @param  {string} storageKey
 * @param  {Object} rawFields — partial fields to merge into raw
 */
AffordabilityRepository.prototype.saveAffordabilityRaw = function (storageKey, rawFields) {
  throw new Error('AffordabilityRepository.saveAffordabilityRaw — not implemented');
};

module.exports = AffordabilityRepository;
