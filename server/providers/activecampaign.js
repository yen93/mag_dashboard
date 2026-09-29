// ActiveCampaign REST API v3 provider.
//
// Unlike Supabase (a pooled pg connection), this is a thin HTTP client over the
// AC REST API. It is OPTIONAL: if AC_API_URL / AC_API_KEY aren't set the metric
// layer skips enrichment and the dependent columns render blank — the app never
// hard-fails on a missing credential.
//
// Auth is an `Api-Token` header. Base URL is the account API endpoint, e.g.
// https://<account>.api-us1.com  (we append /api/3/...). Values here are read
// once per cached build, so we keep calls modest and fail soft (a failed call
// returns null rather than throwing the whole endpoint).

import { config, hasSource } from '../config.js';

export function acConfigured() {
  return hasSource('activecampaign');
}

// Normalise the configured base so both ".../" and bare host work.
function baseUrl() {
  return String(config.activecampaign.apiUrl || '').replace(/\/+$/, '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET `/api/3/<path>` with query params. Returns parsed JSON, or throws on a
 * non-2xx / network error. Retries on 429 (rate limit — AC allows ~5 req/s) and
 * 5xx with backoff, honouring Retry-After. Callers that want fail-soft behaviour
 * should use acGetSafe.
 */
export async function acGet(path, params = {}, { retries = 4 } = {}) {
  const url = new URL(baseUrl() + '/api/3/' + String(path).replace(/^\/+/, ''));
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { 'Api-Token': config.activecampaign.apiKey, Accept: 'application/json' },
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(4000, 300 * 2 ** attempt));
      continue;
    }
    const body = await res.text().catch(() => '');
    throw new Error(`AC ${res.status} ${res.statusText} for ${path}: ${body.slice(0, 200)}`);
  }
}

/** Like acGet but returns null on any error (logs a short diagnostic). */
export async function acGetSafe(path, params = {}) {
  try {
    return await acGet(path, params);
  } catch (err) {
    console.warn('[activecampaign] request failed:', err.message);
    return null;
  }
}

/**
 * Page through a list endpoint that returns `{ <key>: [...], meta: { total } }`.
 * Collects up to `max` records. Fail-soft: returns whatever it gathered.
 */
export async function acPaginate(path, key, params = {}, { pageSize = 100, max = 5000 } = {}) {
  const out = [];
  let offset = 0;
  for (let i = 0; i < 100 && out.length < max; i++) {
    const page = await acGetSafe(path, { ...params, limit: pageSize, offset });
    const rows = page && Array.isArray(page[key]) ? page[key] : [];
    out.push(...rows);
    const total = page && page.meta && Number(page.meta.total);
    offset += pageSize;
    if (!rows.length || (Number.isFinite(total) && offset >= total)) break;
  }
  return out;
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once (AC allows ~5
 * req/s). Preserves input order in the returned results array.
 */
export async function pMapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
