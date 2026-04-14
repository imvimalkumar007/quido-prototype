'use strict';

const POSTCODES_IO_BASE = 'https://api.postcodes.io/postcodes/';
const REQUEST_TIMEOUT_MS = 2500;

function normalisePostcode(value) {
  var compact = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!compact) return '';
  if (compact.length <= 3) return compact;
  return compact.slice(0, -3) + ' ' + compact.slice(-3);
}

function hasUkPostcodeShape(value) {
  var formatted = normalisePostcode(value);
  return /^(GIR 0AA|[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2})$/.test(formatted);
}

function fallbackPostcode(value, reason) {
  var formatted = normalisePostcode(value);
  return {
    valid: hasUkPostcodeShape(formatted),
    postcode: formatted,
    country: '',
    region: '',
    adminDistrict: '',
    adminCounty: '',
    source: 'local-format-check',
    fallbackUsed: true,
    reason: reason || 'Live postcode lookup unavailable.'
  };
}

async function fetchJsonWithTimeout(url) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    var res = await fetch(url, { signal: controller.signal });
    var data = await res.json().catch(function () { return {}; });
    return { ok: res.ok, status: res.status, data: data };
  } finally {
    clearTimeout(timer);
  }
}

async function lookupPostcode(value) {
  var formatted = normalisePostcode(value);
  if (!formatted || !hasUkPostcodeShape(formatted)) {
    return fallbackPostcode(formatted, 'Postcode format is not valid.');
  }
  if (process.env.QUIDO_DISABLE_EXTERNAL_API === '1') {
    return fallbackPostcode(formatted, 'External postcode lookup disabled.');
  }

  try {
    var response = await fetchJsonWithTimeout(POSTCODES_IO_BASE + encodeURIComponent(formatted));
    if (!response.ok || response.status !== 200 || !response.data || !response.data.result) {
      return {
        valid: false,
        postcode: formatted,
        country: '',
        region: '',
        adminDistrict: '',
        adminCounty: '',
        source: 'postcodes.io',
        fallbackUsed: false,
        reason: 'Postcode was not found by Postcodes.io.'
      };
    }
    var result = response.data.result;
    return {
      valid: true,
      postcode: result.postcode || formatted,
      country: result.country || '',
      region: result.region || '',
      adminDistrict: result.admin_district || '',
      adminCounty: result.admin_county || '',
      source: 'postcodes.io',
      fallbackUsed: false,
      quality: result.quality || null
    };
  } catch (err) {
    return fallbackPostcode(formatted, err && err.name === 'AbortError' ? 'Postcode lookup timed out.' : 'Postcode lookup failed.');
  }
}

module.exports = {
  lookupPostcode,
  normalisePostcode,
  hasUkPostcodeShape
};
