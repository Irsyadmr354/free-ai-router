/**
 * lib/mab-routing.js
 * Multi-Armed Bandit (UCB1) provider selection.
 *
 * Replaces the simple reputation-score sort with a statistically sound
 * exploration/exploitation algorithm. UCB1 balances:
 *   - Exploiting providers that have performed well historically
 *   - Exploring providers that haven't been tried enough recently
 *
 * State is persisted to SQLite (router.db → mab_state table) so it
 * survives restarts and grows more accurate over time.
 *
 * UCB1 score = avg_reward + C * sqrt(ln(total_pulls) / provider_pulls)
 *   where C (exploration constant) defaults to sqrt(2) ≈ 1.41.
 *   Higher C = more exploration. Lower C = more exploitation.
 *
 * Reward function:
 *   success + fast (<2s): 1.0
 *   success + normal:     0.8
 *   success + slow (>8s): 0.5
 *   failure:              0.0
 *   429:                  0.0 (and a cooldown is applied separately)
 */

import { getRouterDb } from "./db.js";
import { logError } from "./logger.js";

const EXPLORATION_C = parseFloat(process.env.MAB_EXPLORATION_C ?? String(Math.sqrt(2)));
const ENABLED = process.env.MAB_ROUTING_ENABLED !== "false";

/**
 * Record the outcome of a provider call and update MAB state.
 * @param {string} provider
 * @param {{ success: boolean, latencyMs: number, status: number|null }} outcome
 */
export function recordMabOutcome(provider, { success, latencyMs, status }) {
  if (!ENABLED) return;
  try {
    const db = getRouterDb();
    let reward = 0;
    if (success) {
      if (latencyMs < 2000) reward = 1.0;
      else if (latencyMs < 8000) reward = 0.8;
      else reward = 0.5;
    }
    db.prepare(`
      INSERT INTO mab_state (provider, successes, failures, total_reward, last_updated)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        successes = successes + ?,
        failures = failures + ?,
        total_reward = total_reward + ?,
        last_updated = ?
    `).run(
      provider,
      success ? 1 : 0, success ? 0 : 1, reward, Date.now(),
      success ? 1 : 0, success ? 0 : 1, reward, Date.now()
    );
  } catch (err) {
    logError(`mab-routing: recordMabOutcome failed — ${err.message}`);
  }
}

/**
 * Compute UCB1 score for a provider.
 * Providers with no data get Infinity (always explored first if no data).
 * @param {string} provider
 * @param {number} totalPulls — total pulls across ALL providers
 * @returns {number}
 */
function ucb1Score(provider, totalPulls) {
  try {
    const db = getRouterDb();
    const row = db.prepare("SELECT successes, failures, total_reward FROM mab_state WHERE provider = ?").get(provider);
    if (!row) return Infinity; // never tried — explore first

    const pulls = (row.successes ?? 0) + (row.failures ?? 0);
    if (pulls === 0) return Infinity;

    const avgReward = (row.total_reward ?? 0) / pulls;
    const exploration = EXPLORATION_C * Math.sqrt(Math.log(Math.max(totalPulls, 1)) / pulls);
    return avgReward + exploration;
  } catch {
    return 0.5; // fallback neutral score on DB error
  }
}

/**
 * Reorder providers using UCB1 scores (highest first).
 * Providers with no data are placed first (infinite score = explore).
 * Providers on cooldown keep their position — caller handles cooldown skipping.
 * @param {string[]} order
 * @returns {string[]}
 */
export function sortByMab(order) {
  if (!ENABLED || order.length <= 1) return order;
  try {
    const db = getRouterDb();
    const totalRow = db.prepare("SELECT SUM(successes + failures) as total FROM mab_state").get();
    const totalPulls = totalRow?.total ?? 0;
    return [...order].sort((a, b) => {
      const scoreA = ucb1Score(a, totalPulls);
      const scoreB = ucb1Score(b, totalPulls);
      return scoreB - scoreA; // descending
    });
  } catch {
    return order; // fallback to original order on error
  }
}

/**
 * Get MAB stats snapshot for all providers.
 * @param {string[]} providers
 */
export function getMabSnapshot(providers) {
  try {
    const db = getRouterDb();
    const totalRow = db.prepare("SELECT SUM(successes + failures) as total FROM mab_state").get();
    const totalPulls = totalRow?.total ?? 0;
    return providers.map((p) => {
      const row = db.prepare("SELECT * FROM mab_state WHERE provider = ?").get(p);
      const pulls = (row?.successes ?? 0) + (row?.failures ?? 0);
      return {
        provider: p,
        successes: row?.successes ?? 0,
        failures: row?.failures ?? 0,
        avgReward: pulls > 0 ? Math.round((row.total_reward / pulls) * 1000) / 1000 : null,
        ucb1Score: Math.round(ucb1Score(p, totalPulls) * 1000) / 1000,
        pulls,
      };
    });
  } catch {
    return providers.map((p) => ({ provider: p, pulls: 0, ucb1Score: null }));
  }
}
