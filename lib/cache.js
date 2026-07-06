/**
 * lib/cache.js
 * In-memory response cache keyed on a hash of (provider-order, model, prompt, systemPrompt,
 * maxTokens, temperature). Identical calls within the TTL window skip all provider calls.
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

/**
 * Build a cache key from call parameters.
 * @param {object} params
 * @returns {string}
 */
export function buildKey(params) {
  return JSON.stringify(params);
}

/**
 * Get a cached value. Returns undefined on miss or expiry.
 * @param {string} key
 * @returns {any|undefined}
 */
export function cacheGet(key) {
  if (!ENABLED) return undefined;
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiry) {
    store.delete(key);
    return undefined;
  }
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
  return {
    size: store.size,
    ttlSeconds: TTL_MS / 1000,
    enabled: ENABLED,
  };
}
