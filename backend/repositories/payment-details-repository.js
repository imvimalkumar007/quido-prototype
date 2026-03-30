/**
 * PaymentDetailsRepository — abstract interface
 *
 * Owns the customer's stored payment methods: card and bank account details.
 *
 * In a relational database this maps to a `payment_methods` table
 * (with one row per method type, keyed to the customer).
 * In the prototype it reads/writes the paymentDetails sub-document inside
 * the monolithic account JSON document.
 *
 * Implemented by:
 *   FileDomainStore   — JSON file per account (default)
 *   MemoryDomainStore — in-memory Map (tests)
 */
'use strict';

function PaymentDetailsRepository() {}

/**
 * Return the full paymentDetails sub-document.
 * @param  {string} storageKey
 * @returns {{ card: Object, bank: Object } | null}
 */
PaymentDetailsRepository.prototype.getPaymentDetails = function (storageKey) {
  throw new Error('PaymentDetailsRepository.getPaymentDetails — not implemented');
};

/**
 * Merge updated fields into paymentDetails.
 * @param  {string} storageKey
 * @param  {{ card?: Object, bank?: Object }} fields — partial update
 */
PaymentDetailsRepository.prototype.savePaymentDetails = function (storageKey, fields) {
  throw new Error('PaymentDetailsRepository.savePaymentDetails — not implemented');
};

module.exports = PaymentDetailsRepository;
