/**
 * lib/budget-tracker.js
 * Tracks per-provider request counts against known free-tier limits
 * (day or month window) and reports how close a provider is to its budget.
 * Used to auto-deprioritize providers approaching their limit before
 * they get hit with a real 429.
 *
 * Purely in-memory + persisted alongside usage-log.jsonl reads on demand;
 * counts reset naturally when the window (day/month) rolls over, computed
 * from timestamps rather than a separate timer.
 */

import { getBudget, getBudgetDeprioritizeThreshold } from "./config.js";

/** @type {Map<string, { count: number, windowStart: number }>} */
const counters = new Map();

function windowStartFor(window) {
  const now = new Date();
  if (window === "month") {
    return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  }
  // day window — resets at local midnight
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/**
 * Record one request against a provider's budget counter.
 * @param {string} provider
 */
export function recordBudgetUsage(provider) {
  const { window } = getBudget(provider);
  const start = windowStartFor(window);
  const entry = counters.get(provider);
  if (!entry || entry.windowStart !== start) {
    counters.set(provider, { count: 1, windowStart: start });
  } else {
    entry.count += 1;
  }
}

/**
 * Get current usage info for a provider relative to its known free-tier budget.
 * @param {string} provider
 * @returns {{ count: number, limit: number|null, window: string, ratio: number|null, nearLimit: boolean }}
 */
export function getBudgetUsage(provider) {
  const { limit, window } = getBudget(provider);
  const start = windowStartFor(window);
  const entry = counters.get(provider);
  const count = entry && entry.windowStart === start ? entry.count : 0;
  const ratio = limit ? count / limit : null;
  const nearLimit = ratio !== null && ratio >= getBudgetDeprioritizeThreshold();
  return { count, limit, window, ratio, nearLimit };
}

/**
 * Reorder a provider list so that providers nearing their budget limit
 * (>= threshold) are moved to the end, without excluding them entirely —
 * they're still tried last-resort if everything else fails or is on cooldown.
 * @param {string[]} order
 * @returns {string[]}
 */
export function deprioritizeNearLimitProviders(order) {
  const scored = order.map((p) => ({ p, near: getBudgetUsage(p).nearLimit }));
  const ok = scored.filter((s) => !s.near).map((s) => s.p);
  const near = scored.filter((s) => s.near).map((s) => s.p);
  return [...ok, ...near];
}

/**
 * Return a snapshot of budget usage for every provider passed in.
 * @param {string[]} providers
 */
export function getAllBudgetUsage(providers) {
  return providers.map((p) => ({ provider: p, ...getBudgetUsage(p) }));
}
