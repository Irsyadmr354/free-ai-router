/**
 * lib/warmup.js
 * Background warm-up pool — periodically pings configured providers so the
 * first real user request doesn't pay a cold-start penalty.
 *
 * Interval: PROVIDER_WARMUP_INTERVAL_MS env var, default 5 minutes.
 * Set PROVIDER_WARMUP_ENABLED=false to disable entirely.
 */

import { log, logError } from "./logger.js";
import { markCooldown, isOnCooldown, clearCooldown } from "./cooldown.js";
import { ProviderError } from "./normalize.js";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

let timer = null;

export function isWarmupEnabled() {
  return process.env.PROVIDER_WARMUP_ENABLED === "true";
}

function getInterval() {
  const val = parseInt(process.env.PROVIDER_WARMUP_INTERVAL_MS ?? "", 10);
  return isNaN(val) ? DEFAULT_INTERVAL_MS : val;
}

/**
 * Start the background warm-up loop.
 * @param {() => string[]} getConfiguredProviders - returns provider names with API keys set
 * @param {Record<string, {fn: Function, defaultModel: string}>} registry
 */
export function startWarmupPool(getConfiguredProviders, registry, getApiKeys) {
  if (!isWarmupEnabled()) return;
  if (timer) return;

  const interval = getInterval();
  log(`Provider warm-up pool enabled — pinging every ${Math.round(interval / 1000)}s`);

  timer = setInterval(async () => {
    const providers = getConfiguredProviders();
    const keys = getApiKeys();

    for (const name of providers) {
      if (isOnCooldown(name)) continue;
      const entry = registry[name];
      const apiKey = keys[name];
      if (!entry || !apiKey) continue;

      try {
        await entry.fn({ prompt: "ping", maxTokens: 1, temperature: 0, model: entry.defaultModel, apiKey });
        clearCooldown(name);
      } catch (err) {
        if (err instanceof ProviderError && err.status === 429) markCooldown(name);
        logError(`warm-up ping failed for ${name}: ${err.message}`);
      }
    }
  }, interval);

  // Don't keep the process alive solely for warm-up pings.
  timer.unref?.();
}

export function stopWarmupPool() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
