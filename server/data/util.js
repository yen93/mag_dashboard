// Deterministic pseudo-random helpers so the mock data is stable across
// requests (a given date always yields the same numbers), which makes the
// dashboard feel like it's reading a real, consistent data source.

// Simple string hash -> 32-bit int seed.
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Mulberry32 PRNG -> deterministic float in [0, 1).
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic value for a given key, in [min, max]. */
export function det(key, min, max) {
  const r = rng(hashSeed(key))();
  return min + r * (max - min);
}

/** Deterministic integer for a given key, in [min, max] inclusive. */
export function detInt(key, min, max) {
  return Math.round(det(key, min, max));
}

export const RANGES = {
  '7d': { days: 7, label: 'Last 7 days' },
  '30d': { days: 30, label: 'Last 30 days' },
  '90d': { days: 90, label: 'Last 90 days' },
  ytd: { days: null, label: 'Year to date' },
};

export function normalizeRange(range) {
  return RANGES[range] ? range : '30d';
}

/**
 * Returns an array of ISO date strings (oldest -> newest) for the given range,
 * relative to `now`.
 */
export function dateSeries(range, now = new Date()) {
  const key = normalizeRange(range);
  let start;
  const end = new Date(now);
  if (key === 'ytd') {
    start = new Date(end.getFullYear(), 0, 1);
  } else {
    start = new Date(end);
    start.setDate(end.getDate() - (RANGES[key].days - 1));
  }
  const out = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/** Sum a numeric field across an array of point objects. */
export function sumBy(points, field) {
  return points.reduce((acc, p) => acc + (p[field] || 0), 0);
}

/** Percentage change between two numbers, rounded to 1 decimal. */
export function pctChange(current, previous) {
  if (!previous) return 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}
