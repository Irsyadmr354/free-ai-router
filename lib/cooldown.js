/**
 * lib/cooldown.js
 * In-process cooldown tracker for rate-limited providers.
 * When a provider returns 429, it is marked on cooldown for COOLDOWN_MS.
 * Cooldown state is persisted to disk so it survives server restarts.
 */

import { loadCooldownState, saveCooldownState } from "./cooldown-persist.js";

// Default cooldown: 60 seconds. Override via env PROVIDER_COOLDOWN_MS.
const COOLDOWN_MS = parseInt(process.env.PROVIDER_COOLDOWN_MS ?? "60000", 10);

/** @type {Map<string, number>} provider -> cooldown-expiry timestamp (ms) */
const cooldowns = new Map();

// Load persisted state on module init
loadCooldownState(cooldowns);

/**
 * Mark a provider as rate-limited right now.
 * @param {string} provider
 */
export function markCooldown(provider) {
  cooldowns.set(provider, Date.now() + COOLDOWN_MS);
  saveCooldownState(cooldowns);
}

/**
 * Check whether a provider is currently on cooldown.
 * Automatically clears expired entries.
 * @param {string} provider
 * @returns {boolean}
 */
export function isOnCooldown(provider) {
  const expiry = cooldowns.get(provider);
  if (expiry === undefined) return false;
  if (Date.now() >= expiry) {
    cooldowns.delete(provider);
    saveCooldownState(cooldowns);
    return false;
  }
  return true;
}

/**
 * Return remaining cooldown in seconds (0 if not on cooldown).
 * @param {string} provider
 * @returns {number}
 */
export function cooldownRemainingSeconds(provider) {
  const expiry = cooldowns.get(provider);
  if (expiry === undefined) return 0;
  const remaining = expiry - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

/**
 * Clear cooldown for a provider (e.g. on explicit success).
 * @param {string} provider
 */
export function clearCooldown(provider) {
  cooldowns.delete(provider);
  saveCooldownState(cooldowns);
}

/**
 * Return a snapshot of all current cooldown states.
 * @returns {Array<{ provider: string, remainingSeconds: number }>}
 */
export function allCooldowns() {
  const result = [];
  for (const [provider, expiry] of cooldowns.entries()) {
    const remaining = Math.ceil((expiry - Date.now()) / 1000);
    if (remaining > 0) result.push({ provider, remainingSeconds: remaining });
    else cooldowns.delete(provider);
  }
  saveCooldownState(cooldowns);
  return result;
}
