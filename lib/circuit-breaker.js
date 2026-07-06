/**
 * lib/circuit-breaker.js
 * Circuit breaker pattern for provider health tracking.
 *
 * States per provider:
 *   CLOSED   — normal operation, requests go through
 *   OPEN     — too many recent failures, requests are blocked
 *   HALF_OPEN — testing recovery: one probe request allowed through
 *
 * Transitions:
 *   CLOSED   → OPEN      when consecutiveFailures >= FAILURE_THRESHOLD within WINDOW_MS
 *   OPEN     → HALF_OPEN after RECOVERY_MS has elapsed
 *   HALF_OPEN → CLOSED   on first success
 *   HALF_OPEN → OPEN     on failure (back to waiting)
 *
 * This is separate from cooldown.js (which handles rate-limit 429s).
 * Circuit breaker handles persistent errors: 5xx, repeated timeouts, auth
 * failures — scenarios where backing off longer makes more sense than the
 * 60-second 429 cooldown.
 *
 * Config via env:
 *   CIRCUIT_BREAKER_ENABLED=true          (default: true)
 *   CIRCUIT_FAILURE_THRESHOLD=5           consecutive failures to open (default: 5)
 *   CIRCUIT_WINDOW_MS=120000              failure counting window ms (default: 2 min)
 *   CIRCUIT_RECOVERY_MS=300000            time before half-open probe (default: 5 min)
 */

import { log, logError } from "./logger.js";

const ENABLED = process.env.CIRCUIT_BREAKER_ENABLED !== "false";
const FAILURE_THRESHOLD = parseInt(process.env.CIRCUIT_FAILURE_THRESHOLD ?? "5", 10);
const WINDOW_MS = parseInt(process.env.CIRCUIT_WINDOW_MS ?? "120000", 10);
const RECOVERY_MS = parseInt(process.env.CIRCUIT_RECOVERY_MS ?? "300000", 10);

const CLOSED = "CLOSED";
const OPEN = "OPEN";
const HALF_OPEN = "HALF_OPEN";

/**
 * @typedef {{ state: string, failures: number[], openedAt: number|null }} BreakerState
 */

/** @type {Map<string, BreakerState>} */
const breakers = new Map();

function getBreaker(provider) {
  if (!breakers.has(provider)) {
    breakers.set(provider, { state: CLOSED, failures: [], openedAt: null });
  }
  return breakers.get(provider);
}

/**
 * Check if a request should be allowed through for this provider.
 * Returns true if the circuit is CLOSED or HALF_OPEN (probe allowed).
 * Returns false if the circuit is OPEN and recovery time hasn't elapsed.
 * @param {string} provider
 * @returns {boolean}
 */
export function circuitAllows(provider) {
  if (!ENABLED) return true;
  const b = getBreaker(provider);

  if (b.state === CLOSED) return true;

  if (b.state === OPEN) {
    const elapsed = Date.now() - (b.openedAt ?? 0);
    if (elapsed >= RECOVERY_MS) {
      b.state = HALF_OPEN;
      log(`Circuit breaker: ${provider} → HALF_OPEN (probing after ${Math.round(elapsed / 1000)}s)`);
      return true;
    }
    return false;
  }

  // HALF_OPEN — allow exactly one probe through (caller must call recordSuccess/recordFailure after)
  return true;
}

/**
 * Record a successful call. Resets the breaker to CLOSED.
 * @param {string} provider
 */
export function cbRecordSuccess(provider) {
  if (!ENABLED) return;
  const b = getBreaker(provider);
  if (b.state !== CLOSED) {
    log(`Circuit breaker: ${provider} → CLOSED (recovered)`);
  }
  b.state = CLOSED;
  b.failures = [];
  b.openedAt = null;
}

/**
 * Record a failed call. Opens the circuit if threshold exceeded.
 * 429 rate-limit errors should NOT be counted here — use cooldown.js instead.
 * @param {string} provider
 * @param {number|null} httpStatus  — pass null for network/timeout errors
 */
export function cbRecordFailure(provider, httpStatus) {
  if (!ENABLED) return;
  // Don't open the breaker for 429 (handled by cooldown) or 401/403 (auth — won't fix itself)
  if (httpStatus === 429 || httpStatus === 401 || httpStatus === 403) return;

  const b = getBreaker(provider);
  const now = Date.now();

  // Prune failures outside the counting window
  b.failures = b.failures.filter((t) => now - t < WINDOW_MS);
  b.failures.push(now);

  if (b.state === HALF_OPEN) {
    // Probe failed — back to OPEN, reset timer
    b.state = OPEN;
    b.openedAt = now;
    logError(`Circuit breaker: ${provider} probe FAILED → OPEN (retry in ${RECOVERY_MS / 1000}s)`);
    return;
  }

  if (b.failures.length >= FAILURE_THRESHOLD) {
    b.state = OPEN;
    b.openedAt = now;
    logError(`Circuit breaker: ${provider} OPENED after ${b.failures.length} failures in ${WINDOW_MS / 1000}s window`);
  }
}

/**
 * Return remaining seconds until a provider's circuit breaker allows probing.
 * Returns 0 if the circuit is closed or already in half-open.
 * @param {string} provider
 * @returns {number}
 */
export function circuitRemainingSeconds(provider) {
  if (!ENABLED) return 0;
  const b = getBreaker(provider);
  if (b.state !== OPEN) return 0;
  const remaining = RECOVERY_MS - (Date.now() - (b.openedAt ?? 0));
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

/**
 * Return a snapshot of all circuit breaker states.
 * @returns {Array<{ provider: string, state: string, failures: number, remainingSeconds: number }>}
 */
export function allCircuitStates() {
  const result = [];
  for (const [provider, b] of breakers.entries()) {
    result.push({
      provider,
      state: b.state,
      failures: b.failures.length,
      remainingSeconds: circuitRemainingSeconds(provider),
    });
  }
  return result;
}

/**
 * Manually reset a provider's circuit breaker to CLOSED.
 * @param {string} provider
 */
export function resetCircuit(provider) {
  breakers.delete(provider);
}
