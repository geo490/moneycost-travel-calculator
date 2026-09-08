// netlify/functions/search.js
//
// Server-side search proxy for the Travel Cost Calculator.
// Browser -> this function -> SearXNG (https://moneycost-searxng-2.onrender.com) -> search engines -> normalized JSON -> browser.
//
// Why this exists: SearXNG's JSON API is not meant to be called directly from arbitrary
// browser JavaScript. Most public instances disable `format=json` specifically to prevent
// that kind of scraping/abuse, and even on an instance that allows it, calling it straight
// from the client would expose the instance URL (and invite abuse of it) to every visitor.
// Routing through this function keeps the SearXNG URL server-side only.
//
// ENDPOINT: defaults to the confirmed-working instance below. Override with the
// SEARXNG_BASE_URL environment variable (Netlify: Site settings -> Environment variables)
// if you ever move to a different instance -- no code change needed for that.
const DEFAULT_SEARXNG_BASE_URL = 'https://moneycost-searxng-2.onrender.com';
//
// This function does not require or expose any API key -- SearXNG itself has none.
// It never forwards SearXNG's raw response shape to the client; it normalizes to:
//   { success: true, results: [ {name, address, city, region, country, category,
//                                 website, sourceName, sourceUrl, sourceType, engine, snippet} ... ] }
//   or
//   { success: false, errorType: "SEARCH_PROVIDER_UNAVAILABLE" | "NO_RESULTS" | "INTERNAL_ERROR", message }
//
// COLD START: this SearXNG instance runs on Render's free tier, which sleeps after
// inactivity and can take 30-50+ seconds to wake on the first request. The upstream
// timeout below is set close to Netlify's own function execution ceiling (~26s on most
// plans) to give a cold start the best realistic chance within a single invocation, and
// one retry is attempted after a short pause specifically for connection-level failures
// (the kind a still-waking instance produces) -- not for a clean HTTP error, and not in
// a loop. If the instance is still asleep after both attempts, the frontend's own retry
// (a separate, user-triggered "Retry Search" click) will very likely succeed, since the
// first request's wake-up call keeps the instance warm for a while afterward.

const MAX_RESULTS = 8;
const UPSTREAM_TIMEOUT_MS = 22000;
const RETRY_DELAY_MS = 2000;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { success: false, errorType: 'INTERNAL_ERROR', message: 'Method not allowed' });
  }

  const base = process.env.SEARXNG_BASE_URL || DEFAULT_SEARXNG_BASE_URL;

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { success: false, errorType: 'INTERNAL_ERROR', message: 'Malformed request body' });
  }

  const { query, country, region, city, area, type, typeHint } = body;
  if (!query || typeof query !== 'string') {
    return json(400, { success: false, errorType: 'INTERNAL_ERROR', message: 'Missing "query"' });
  }

  // --- Query builder (spec: append available location context, most specific first) ---
  // This is what preserves flexible/partial/multi-word search for every place category
  // (museums, restaurants, theme parks, Comic Cons, activities, tickets, etc.) -- SearXNG's
  // underlying engines already handle partial and multi-word matching natively; this
  // function's only job is to build a good query string and normalize what comes back,
  // not to add category-specific logic that could narrow results unexpectedly.
  const parts = [query.trim()];
  if (city) parts.push(city);
  if (area) parts.push(area); // island / destination area
  if (region && !area) parts.push(region);
  if (country) parts.push(country);
  const builtQuery = parts.filter(Boolean).join(' ');

  const searchUrl = `${base.replace(/\/$/, '')}/search?` + new URLSearchParams({
    q: builtQuery,
    format: 'json',
    language: 'en'
  }).toString();

  let upstream;
  try {
    upstream = await fetchWithRetry(searchUrl, UPSTREAM_TIMEOUT_MS);
  } catch (e) {
    console.error('[search] upstream request failed after retry:', e.message);
    return json(502, { success: false, errorType: 'SEARCH_PROVIDER_UNAVAILABLE', message: 'Could not reach the search provider (it may still be waking up from being idle -- try again in a moment)' });
  }

  if (!upstream.ok) {
    console.error('[search] upstream returned', upstream.status);
    return json(502, { success: false, errorType: 'SEARCH_PROVIDER_UNAVAILABLE', message: `Search provider returned HTTP ${upstream.status}` });
  }

  let data;
  try {
    data = await upstream.json();
  } catch (e) {
    console.error('[search] upstream returned non-JSON -- is format=json actually enabled on this instance?');
    return json(502, { success: false, errorType: 'SEARCH_PROVIDER_UNAVAILABLE', message: 'Search provider did not return JSON' });
  }

  // Empty results is a normal, successful outcome -- not an error state. The frontend
  // already distinguishes "No matching verified information found" from a failed request
  // using this same success:true/results:[] shape.
  const rawResults = Array.isArray(data.results) ? data.results : [];
  const results = rawResults.slice(0, MAX_RESULTS).map((r) => normalizeResult(r, { country, region, city, area, type, typeHint }));

  return json(200, { success: true, results });
};

function normalizeResult(r, ctx) {
  let hostname = '';
  try { hostname = new URL(r.url).hostname.replace(/^www\./, ''); } catch (e) { /* leave blank */ }
  return {
    name: r.title || hostname || 'Result',
    address: null, // SearXNG's general search engines don't reliably return a structured address
    city: ctx.city || null,
    region: ctx.region || null,
    country: ctx.country || null,
    category: ctx.typeHint || ctx.type || null,
    website: r.url || null,
    sourceName: hostname || r.engine || 'Search result',
    sourceUrl: r.url || null,
    sourceType: 'search_result', // the frontend/user assigns Official/Officially Sourced/etc. on manual confirmation
    engine: r.engine || null,     // which underlying search engine produced this result, when SearXNG reports one
    snippet: r.content || ''
  };
}

// One retry, ONLY for a connection-level failure (timeout, refused, DNS, etc. -- exactly
// what a still-waking Render free-tier instance produces) -- never for a clean HTTP
// error response, and never more than once, so this can't become a retry loop.
async function fetchWithRetry(url, timeoutMs) {
  try {
    return await fetchWithTimeout(url, timeoutMs);
  } catch (firstErr) {
    console.error('[search] first attempt failed (likely cold start), retrying once:', firstErr.message);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return await fetchWithTimeout(url, timeoutMs);
  }
}

function fetchWithTimeout(url, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Upstream request timed out')), ms);
    fetch(url, { headers: { 'Accept': 'application/json' } })
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
