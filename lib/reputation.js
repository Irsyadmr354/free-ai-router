/**
 * lib/reputation.js
 * Provider reputation system (Batch 6 flagship feature).
 *
 * Each provider has a reputation score 0-100 that updates based on:
 *   - response time (relative to other providers)
 *   - error rate
 *   - 429 (rate-limit) history
 *
 * The score decays gently toward neutral (70) when a provider has no
 * recent activity, so a provider that was bad yesterday isn't punished
 * forever, and a provider with zero data isn't assumed perfect.
 */

import { getBenchmark } from "./benchmark.js";

const NEUTRAL_SCORE = 70;
const MIN_SCORE = 0;
const MAX_SCORE = 100;

/** @type {Map<string, { score: number, last429At: number|null, lastUpdated: number }>} */
const reputation = new Map();

function getEntry(provider) {
  if (!reputation.has(provider)) {
    reputation.set(provider, { score: NEUTRAL_SCORE, last429At: null, lastUpdated: Date.now() });
  }
  return reputation.get(provider);
}

/**
 * Update a provider's reputation after a call outcome.
 * @param {string} provider
 * @param {{ success: boolean, latencyMs: number, status?: number|null }} outcome
 */
export function updateReputation(provider, { success, latencyMs, status = null }) {
  const entry = getEntry(provider);

  if (status === 429) {
    entry.last429At = Date.now();
    entry.score = Math.max(MIN_SCORE, entry.score - 15);
  } else if (!success) {
    entry.score = Math.max(MIN_SCORE, entry.score - 8);
  } else {
    // Reward success; extra reward for fast responses (<2s), small penalty for slow (>8s).
    let delta = 3;
    if (latencyMs < 2000) delta += 2;
    else if (latencyMs > 8000) delta -= 2;
    entry.score = Math.min(MAX_SCORE, entry.score + delta);
  }

  entry.lastUpdated = Date.now();
}

/**
 * Get a provider's current reputation score, applying gentle decay toward
 * neutral if it hasn't been updated recently (so stale extremes fade).
 * @param {string} provider
 * @returns {number}
 */
export function getReputationScore(provider) {
  const entry = getEntry(provider);
  const hoursSinceUpdate = (Date.now() - entry.lastUpdated) / 3_600_000;
  if (hoursSinceUpdate < 1) return Math.round(entry.score);

  // Decay 1 point per hour of inactivity toward neutral, capped so it
  // doesn't overshoot.
  const decaySteps = Math.min(hoursSinceUpdate, Math.abs(entry.score - NEUTRAL_SCORE));
  const decayed = entry.score > NEUTRAL_SCORE
    ? entry.score - decaySteps
    : entry.score + decaySteps;
  return Math.round(decayed);
}

/**
 * Reorder providers by reputation score, highest first. Ties broken by
 * original order (stable sort).
 * @param {string[]} order
 * @returns {string[]}
 */
export function sortByReputation(order) {
  return [...order]
    .map((p, i) => ({ p, i, score: getReputationScore(p) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.p);
}

/**
 * Snapshot of reputation + underlying benchmark for every provider.
 * @param {string[]} providers
 */
export function getReputationSnapshot(providers) {
  return providers.map((p) => ({
    provider: p,
    reputation: getReputationScore(p),
    benchmark: getBenchmark(p),
  }));
}
