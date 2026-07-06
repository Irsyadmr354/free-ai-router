/**
 * lib/anomaly-detector.js
 * Proactive anomaly detection for provider latency.
 *
 * Monitors a rolling average latency per provider and flags when a provider's
 * current latency spikes significantly above its baseline — before it causes
 * errors or timeouts. A flagged provider is deprioritized (moved to end of
 * order) rather than blocked entirely, preserving it as last-resort fallback.
 *
 * Algorithm:
 *   - Maintain a rolling baseline (EMA — Exponential Moving Average) per provider
 *   - After each call, update EMA: new_ema = alpha * latency + (1-alpha) * old_ema
 *   - If current latency > baseline * SPIKE_THRESHOLD, mark as "degraded"
 *   - Degraded state auto-clears after DEGRADED_TTL_MS of good calls
 *
 * Config (all via env):
 *   ANOMALY_DETECTION_ENABLED=true
 *   ANOMALY_SPIKE_THRESHOLD=3.0    (latency > 3x baseline = anomaly)
 *   ANOMALY_EMA_ALPHA=0.15         (smoothing factor, lower = slower to update)
 *   ANOMALY_DEGRADED_TTL_MS=120000 (2 min before degraded state auto-clears)
 *   ANOMALY_MIN_SAMPLES=5          (minimum samples before anomaly detection activates)
 */

import { log, logError } from "./logger.js";

const ENABLED = process.env.ANOMALY_DETECTION_ENABLED !== "false";
const SPIKE_THRESHOLD = parseFloat(process.env.ANOMALY_SPIKE_THRESHOLD ?? "3.0");
const EMA_ALPHA = parseFloat(process.env.ANOMALY_EMA_ALPHA ?? "0.15");
const DEGRADED_TTL_MS = parseInt(process.env.ANOMALY_DEGRADED_TTL_MS ?? "120000", 10);
const MIN_SAMPLES = parseInt(process.env.ANOMALY_MIN_SAMPLES ?? "5", 10);

/** @type {Map<string, { ema: number, samples: number, degradedUntil: number|null }>} */
const state = new Map();

function getState(provider) {
  if (!state.has(provider)) {
    state.set(provider, { ema: 0, samples: 0, degradedUntil: null });
  }
  return state.get(provider);
}

/**
 * Record a call outcome and update anomaly detection state.
 * @param {string} provider
 * @param {number} latencyMs
 * @param {boolean} success
 */
export function recordAnomalyDataPoint(provider, latencyMs, success) {
  if (!ENABLED || !success) return; // only track successful calls for baseline

  const s = getState(provider);
  s.samples++;

  if (s.samples === 1) {
    s.ema = latencyMs; // first sample = initial EMA
    return;
  }

  const prevEma = s.ema;
  s.ema = EMA_ALPHA * latencyMs + (1 - EMA_ALPHA) * prevEma;

  // Only detect anomalies once we have enough samples for a reliable baseline
  if (s.samples < MIN_SAMPLES) return;

  if (latencyMs > prevEma * SPIKE_THRESHOLD) {
    s.degradedUntil = Date.now() + DEGRADED_TTL_MS;
    logError(`anomaly-detector: ${provider} latency spike — ${latencyMs}ms vs baseline ${Math.round(prevEma)}ms (${(latencyMs / prevEma).toFixed(1)}x) → degraded for ${DEGRADED_TTL_MS / 1000}s`);
  } else if (s.degradedUntil && Date.now() > s.degradedUntil) {
    s.degradedUntil = null; // auto-clear after TTL
  }
}

/**
 * Check whether a provider is currently in degraded state.
 * Degraded providers should be deprioritized but not blocked.
 * @param {string} provider
 * @returns {boolean}
 */
export function isProviderDegraded(provider) {
  if (!ENABLED) return false;
  const s = state.get(provider);
  if (!s?.degradedUntil) return false;
  if (Date.now() > s.degradedUntil) {
    s.degradedUntil = null;
    return false;
  }
  return true;
}

/**
 * Reorder providers so degraded ones go to the end.
 * @param {string[]} order
 * @returns {string[]}
 */
export function deprioritizeDegradedProviders(order) {
  if (!ENABLED) return order;
  const ok = order.filter((p) => !isProviderDegraded(p));
  const degraded = order.filter((p) => isProviderDegraded(p));
  return [...ok, ...degraded];
}

/**
 * Return anomaly detection snapshot for all providers.
 * @param {string[]} providers
 */
export function getAnomalySnapshot(providers) {
  return providers.map((p) => {
    const s = state.get(p);
    return {
      provider: p,
      baselineMs: s ? Math.round(s.ema) : null,
      samples: s?.samples ?? 0,
      degraded: isProviderDegraded(p),
      degradedRemainingSeconds: s?.degradedUntil
        ? Math.max(0, Math.ceil((s.degradedUntil - Date.now()) / 1000))
        : 0,
    };
  });
}

/**
 * Manually clear degraded state for a provider (e.g. after manual recovery).
 * @param {string} provider
 */
export function clearDegradedState(provider) {
  const s = state.get(provider);
  if (s) s.degradedUntil = null;
}
