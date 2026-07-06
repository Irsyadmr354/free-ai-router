/**
 * lib/request-queue.js
 * Request queue for when ALL providers are on cooldown or circuit-open.
 *
 * Instead of immediately throwing "All providers failed", requests are held
 * for up to QUEUE_TIMEOUT_MS waiting for the soonest provider to come back
 * online, then retried automatically.
 *
 * Config via env:
 *   REQUEST_QUEUE_ENABLED=true          (default: true)
 *   REQUEST_QUEUE_TIMEOUT_MS=30000      max wait before giving up (default: 30s)
 *   REQUEST_QUEUE_MAX_SIZE=20           max concurrent queued requests (default: 20)
 */

import { log, logError } from "./logger.js";
import { cooldownRemainingSeconds } from "./cooldown.js";
import { circuitRemainingSeconds } from "./circuit-breaker.js";

const ENABLED = process.env.REQUEST_QUEUE_ENABLED !== "false";
const TIMEOUT_MS = parseInt(process.env.REQUEST_QUEUE_TIMEOUT_MS ?? "30000", 10);
const MAX_SIZE = parseInt(process.env.REQUEST_QUEUE_MAX_SIZE ?? "20", 10);

let queueSize = 0;

/**
 * Given an ordered list of provider names, return the number of milliseconds
 * until the soonest provider becomes available (cooldown or circuit-open).
 * Returns 0 if at least one provider is available right now.
 * Returns Infinity if no providers are configured or all are permanently blocked.
 *
 * @param {string[]} order
 * @param {Record<string,string>} keys
 * @returns {number}
 */
export function msUntilAnyProviderAvailable(order, keys) {
  let soonest = Infinity;
  for (const provider of order) {
    if (!keys[provider]) continue; // no key — skip
    const cd = cooldownRemainingSeconds(provider) * 1000;
    const cb = circuitRemainingSeconds(provider) * 1000;
    const wait = Math.max(cd, cb);
    if (wait === 0) return 0; // at least one available now
    soonest = Math.min(soonest, wait);
  }
  return soonest;
}

/**
 * Wait until at least one provider in `order` becomes available, then call
 * `fn()` and return its result. If no provider becomes available within
 * TIMEOUT_MS, throws with a clear message.
 *
 * Returns immediately (calling fn with no delay) if a provider is already
 * available or the queue is disabled.
 *
 * @template T
 * @param {string[]} order
 * @param {Record<string,string>} keys
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function queueOrRun(order, keys, fn) {
  if (!ENABLED) return fn();

  const waitMs = msUntilAnyProviderAvailable(order, keys);
  if (waitMs === 0) return fn(); // fast path — no wait needed

  if (waitMs === Infinity) {
    // No configured providers at all
    throw new Error("No providers are configured (missing API keys).");
  }

  if (queueSize >= MAX_SIZE) {
    throw new Error(`Request queue is full (${MAX_SIZE} requests waiting). Try again shortly.`);
  }

  if (waitMs > TIMEOUT_MS) {
    throw new Error(
      `All providers are temporarily unavailable. Soonest recovery in ${Math.ceil(waitMs / 1000)}s, ` +
      `which exceeds the queue timeout of ${TIMEOUT_MS / 1000}s. Try again later.`
    );
  }

  queueSize++;
  const waitSec = Math.ceil(waitMs / 1000);
  log(`All providers unavailable — queuing request, retrying in ${waitSec}s (${queueSize} queued)`);

  try {
    await new Promise((resolve) => setTimeout(resolve, waitMs + 200)); // +200ms buffer
    log(`Queue wait complete — retrying request`);
    return await fn();
  } finally {
    queueSize--;
  }
}

/**
 * Return current queue depth.
 * @returns {number}
 */
export function getQueueDepth() {
  return queueSize;
}
