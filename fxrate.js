// netlify/functions/fxrate.js
//
// Server-side proxy for the European Central Bank's public daily euro foreign-exchange
// reference-rate feed. No API key, no account, no rate limit beyond ECB's own (they publish
// this file once per working day). Routed through a function -- rather than fetched directly
// from the browser -- purely so the frontend has one consistent same-origin backend pattern
// and so a future swap of data source doesn't require a frontend change.
//
// Source: https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml
// This file always contains the LATEST published reference rates -- if today's aren't out yet
// (ECB publishes around 16:00 CET on working days, not on weekends/TARGET holidays), it simply
// contains the most recent working day's rates, with that day's real date in the file. This
// function never invents a fresher date than what the feed actually reports.

const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const UPSTREAM_TIMEOUT_MS = 8000;

// A tiny in-memory cache shared across warm invocations of this function instance.
// Best-effort only (serverless instances are ephemeral) -- the frontend has its own
// session-level cache regardless, this just spares redundant ECB fetches when warm.
let cache = { date: null, rates: null, fetchedAt: 0 };
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { success: false, errorType: 'INTERNAL_ERROR', message: 'Method not allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { success: false, errorType: 'INTERNAL_ERROR', message: 'Malformed request body' });
  }

  const ccy = (body.ccy || '').toUpperCase();
  if (!ccy || !/^[A-Z]{3}$/.test(ccy)) {
    return json(400, { success: false, errorType: 'INTERNAL_ERROR', message: 'Missing or invalid "ccy"' });
  }
  if (ccy === 'EUR') {
    return json(200, { success: true, rate: 1, date: new Date().toISOString().slice(0, 10), sourceName: 'Same currency', sourceUrl: '' });
  }

  try {
    const { date, rates } = await getRates();
    const rate = rates[ccy];
    if (typeof rate !== 'number') {
      // A genuinely unsupported currency for this feed -- ECB's daily file covers roughly
      // 30 major currencies, not all ISO 4217 codes. Report it plainly rather than guessing.
      return json(200, { success: false, errorType: 'NO_RESULTS', message: `No ECB reference rate is published for ${ccy}` });
    }
    return json(200, {
      success: true,
      rate,
      date,
      sourceName: 'European Central Bank',
      sourceUrl: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'
    });
  } catch (e) {
    console.error('[fxrate] failed:', e.message);
    return json(502, { success: false, errorType: 'SEARCH_PROVIDER_UNAVAILABLE', message: 'Could not reach the exchange-rate provider' });
  }
};

async function getRates() {
  if (cache.rates && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS) {
    return cache;
  }
  const res = await fetchWithTimeout(ECB_URL, UPSTREAM_TIMEOUT_MS);
  if (!res.ok) throw new Error(`ECB feed returned HTTP ${res.status}`);
  const xml = await res.text();

  // The feed is a small, flat, well-known structure:
  // <Cube time='2026-08-24'><Cube currency='USD' rate='1.1664'/>...</Cube>
  // A tiny regex parse is sufficient and avoids pulling in an XML dependency for one field shape.
  const dateMatch = xml.match(/<Cube\s+time=['"]([\d-]+)['"]/);
  const date = dateMatch ? dateMatch[1] : null;
  if (!date) throw new Error('Could not find a reference date in the ECB feed');

  const rates = {};
  const re = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    rates[m[1]] = parseFloat(m[2]);
  }
  if (Object.keys(rates).length === 0) throw new Error('No currency rates parsed from the ECB feed');

  cache = { date, rates, fetchedAt: Date.now() };
  return cache;
}

function fetchWithTimeout(url, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Upstream request timed out')), ms);
    fetch(url)
      .then((res) => { clearTimeout(timer); resolve(res); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  };
}
