/**
 * ScheduleRepository — abstract interface
 *
 * Owns the repayment schedule snapshot for a loan.
 * The schedule is the full amortisation table as last computed by the
 * schedule engine.  It is stored as a snapshot (not recomputed on every read).
 *
 * In a relational database this maps to a `schedule_rows` table keyed on
 * (loan_id, instalment_n).  A schedule save replaces all existing rows.
 * In the prototype it reads/writes loan.scheduleSnapshot inside the
 * monolithic account JSON document.
 *
 * Implemented by:
 *   FileDomainStore   — JSON file per account (default)
 *   MemoryDomainStore — in-memory Map (tests)
 */
'use strict';

function ScheduleRepository() {}

/**
 * Return the schedule snapshot for a loan.
 * Each row: { n, dueDate, emi, principal, interest, balance, status, ph, pa }
 * @param  {string} storageKey
 * @param  {string} loanId
 * @returns {Object[]}
 */
ScheduleRepository.prototype.getSchedule = function (storageKey, loanId) {
  throw new Error('ScheduleRepository.getSchedule — not implemented');
};

/**
 * Replace the schedule snapshot for a loan.
 * All existing rows are overwritten by the provided array.
 * @param  {string} storageKey
 * @param  {string} loanId
 * @param  {Object[]} rows
 */
ScheduleRepository.prototype.saveSchedule = function (storageKey, loanId, rows) {
  throw new Error('ScheduleRepository.saveSchedule — not implemented');
};

module.exports = ScheduleRepository;
