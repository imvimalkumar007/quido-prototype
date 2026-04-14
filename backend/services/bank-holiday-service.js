'use strict';

const BANK_HOLIDAYS_URL = 'https://www.gov.uk/bank-holidays.json';
const REQUEST_TIMEOUT_MS = 2500;

const FALLBACK_BANK_HOLIDAYS = {
  'england-and-wales': [
    '2026-01-01',
    '2026-04-03',
    '2026-04-06',
    '2026-05-04',
    '2026-05-25',
    '2026-08-31',
    '2026-12-25',
    '2026-12-28',
    '2027-01-01',
    '2027-03-26',
    '2027-03-29',
    '2027-05-03',
    '2027-05-31',
    '2027-08-30',
    '2027-12-27',
    '2027-12-28'
  ]
};

function pad(n) { return String(n).padStart(2, '0'); }

function toIsoDate(date) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function parseIsoDate(value) {
  var parts = String(value || '').split('-').map(Number);
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  var date = new Date(parts[0], parts[1] - 1, parts[2]);
  if (isNaN(date.getTime())) return null;
  return date;
}

function addDays(date, days) {
  var copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() + days);
  return copy;
}

function isWeekend(date) {
  var day = date.getDay();
  return day === 0 || day === 6;
}

function fallbackEvents(division) {
  return (FALLBACK_BANK_HOLIDAYS[division] || FALLBACK_BANK_HOLIDAYS['england-and-wales']).map(function (date) {
    return { date: date, title: 'Bank holiday' };
  });
}

async function fetchJsonWithTimeout(url) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    var res = await fetch(url, { signal: controller.signal });
    var data = await res.json().catch(function () { return {}; });
    return { ok: res.ok, data: data };
  } finally {
    clearTimeout(timer);
  }
}

async function getHolidayEvents(division) {
  var safeDivision = division || 'england-and-wales';
  if (process.env.QUIDO_DISABLE_EXTERNAL_API === '1') {
    return { events: fallbackEvents(safeDivision), source: 'local-fallback', fallbackUsed: true };
  }
  try {
    var response = await fetchJsonWithTimeout(BANK_HOLIDAYS_URL);
    var block = response.ok && response.data && response.data[safeDivision];
    if (!block || !Array.isArray(block.events)) {
      return { events: fallbackEvents(safeDivision), source: 'local-fallback', fallbackUsed: true };
    }
    return { events: block.events, source: 'gov.uk-bank-holidays', fallbackUsed: false };
  } catch (err) {
    return { events: fallbackEvents(safeDivision), source: 'local-fallback', fallbackUsed: true };
  }
}

function calculateNextWorkingDay(fromDate, events, allowSameDay) {
  var holidays = {};
  (events || []).forEach(function (event) { holidays[event.date] = event.title || 'Bank holiday'; });
  var candidate = allowSameDay ? addDays(fromDate, 0) : addDays(fromDate, 1);
  for (var i = 0; i < 370; i++) {
    var iso = toIsoDate(candidate);
    if (!isWeekend(candidate) && !holidays[iso]) {
      return { date: iso, holidayTitle: '' };
    }
    candidate = addDays(candidate, 1);
  }
  return { date: toIsoDate(candidate), holidayTitle: '' };
}

async function getDisbursalCalendar(options) {
  options = options || {};
  var division = options.division || 'england-and-wales';
  var fromDate = parseIsoDate(options.date) || new Date();
  var holidayData = await getHolidayEvents(division);
  var next = calculateNextWorkingDay(fromDate, holidayData.events, options.allowSameDay !== false);
  return {
    requestedDate: toIsoDate(fromDate),
    nextWorkingDate: next.date,
    sameDayAvailable: next.date === toIsoDate(fromDate),
    division: division,
    source: holidayData.source,
    fallbackUsed: holidayData.fallbackUsed
  };
}

module.exports = {
  getDisbursalCalendar,
  calculateNextWorkingDay,
  toIsoDate
};
