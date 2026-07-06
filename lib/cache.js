/**
 * lib/cache.js
 * In-memory response cache keyed on a hash of (model, prompt, systemPrompt,
 * maxTokens, temperature). Identical calls within the TTL window skip all provider calls.
 *
 * NOTE: provider order is intentionally excluded from the cache key — the
 * order in which providers are tried has no effect on the actual output,
 * so including it in the key only caused unnecessary cache misses.
 *
 * TTL: default 5 minutes. Override via env CACHE_TTL_MS.
 * Max entries: 200 (LRU-lite: evict oldest on overflow).
 * Set CACHE_ENABLED=false to disable entirely.
 */

const TTL_MS = parseInt(process.env.CACHE_TTL_MS ?? "300000", 10);
const MAX_ENTRIES = 200;
const ENABLED = process.env.CACHE_ENABLED !== "false";

/** @type {Map<string, { value: any, expiry: number }>} */
const store = new Map();

// Hit/miss counters for cache hit rate reporting (e.g. /v1/health).
let hits = 0;
let misses = 0;

/**
 * Build a cache key from call parameters.
 * Only fields that actually affect the output are included.
 * @param {object} params
 * @returns {string}
 */
export function buildKey(params) {
  const { model, prompt, system_prompt, max_tokens, temperature, image_url, image_base64 } = params;
  return JSON.stringify({ model, prompt, system_prompt, max_tokens, temperature, image_url, image_base64 });
}

/**
 * Get a cached value. Returns undefined on miss or expiry.
 * @param {string} key
 * @returns {any|undefined}
 */
export function cacheGet(key) {
  if (!ENABLED) return undefined;
  const entry = store.get(key);
  if (!entry) {
    misses++;
    return undefined;
  }
  if (Date.now() >= entry.expiry) {
    store.delete(key);
    misses++;
    return undefined;
  }
  hits++;
  return entry.value;
}

/**
 * Store a value in the cache.
 * @param {string} key
 * @param {any} value
 */
export function cacheSet(key, value) {
  if (!ENABLED) return;
  // Evict oldest entry if at capacity
  if (store.size >= MAX_ENTRIES) {
    const firstKey = store.keys().next().value;
    store.delete(firstKey);
  }
  store.set(key, { value, expiry: Date.now() + TTL_MS });
}

/**
 * Return cache statistics.
 * @returns {{ size: number, ttlSeconds: number, enabled: boolean }}
 */
export function cacheStats() {
  const total = hits + misses;
  return {
    size: store.size,
    ttlSeconds: TTL_MS / 1000,
    enabled: ENABLED,
    hits,
    misses,
    hitRate: total > 0 ? hits / total : null,
  };
}

/**
 * Clear all cached entries.
 * @returns {number} number of entries removed
 */
export function cacheClear() {
  const count = store.size;
  store.clear();
  return count;
}
