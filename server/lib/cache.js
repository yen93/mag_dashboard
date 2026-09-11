// Tiny in-memory TTL cache. Cloud Run scales to zero and runs few instances, so
// a per-instance cache with a short TTL is enough to keep repeated dashboard
// loads from re-hitting the external APIs on every request.

const store = new Map(); // key -> { value, expires }

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Get a cached value or compute+cache it.
 * @param {string} key
 * @param {() => Promise<any>} producer
 * @param {number} [ttlMs]
 */
export async function cached(key, producer, ttlMs = DEFAULT_TTL_MS) {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await producer();
  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

export function clearCache() {
  store.clear();
}
