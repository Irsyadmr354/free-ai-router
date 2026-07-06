/**
 * lib/dedup.js
 * Request deduplication — if two identical chat_completion calls arrive
 * concurrently (same cache key), the second one awaits the first one's
 * in-flight promise instead of making its own provider call.
 *
 * This is separate from lib/cache.js (which caches *completed* results for
 * a TTL window) — this only covers the brief window while a call is
 * actually in flight.
 */

/** @type {Map<string, Promise<any>>} */
const inFlight = new Map();

/**
 * Run `fn` for the given key, sharing the in-flight promise with any other
 * concurrent caller using the same key. The map entry is cleared once the
 * promise settles (success or failure), so it never leaks and each new
 * request cycle gets a fresh call.
 * @param {string} key
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
export function dedupe(key, fn) {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = fn().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

/**
 * @returns {number} number of requests currently in flight and shared
 */
export function inFlightCount() {
  return inFlight.size;
}
