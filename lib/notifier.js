/**
 * lib/notifier.js
 * Sends a notification when all providers fail.
 * Currently supports Discord webhooks.
 *
 * Configure via .env:
 *   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
 *
 * Leave unset to disable — completely optional.
 */

import { logError } from "./logger.js";

/**
 * Notify configured channels that all providers have failed.
 * Non-blocking — never throws, failures are logged to stderr only.
 * @param {string} errorSummary  — The full error summary string
 */
export async function notifyAllProvidersFailed(errorSummary) {
  await Promise.allSettled([
    notifyDiscord(errorSummary),
  ]);
}

async function notifyDiscord(errorSummary) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;

  const payload = {
    username: "free-ai-router",
    embeds: [{
      title: "🚨 All providers failed",
      description: errorSummary.slice(0, 4000),
      color: 0xff4444,
      timestamp: new Date().toISOString(),
    }],
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logError(`Discord webhook returned ${res.status}`);
    }
  } catch (err) {
    logError(`Discord webhook failed: ${err.message}`);
  }
}

/**
 * Notify configured channels that a provider has recovered — i.e. its
 * circuit breaker's HALF_OPEN probe succeeded and it transitioned back to
 * CLOSED after being OPEN. Non-blocking, never throws.
 * Disabled by default; enable via NOTIFY_ON_RECOVERY=true (still requires
 * DISCORD_WEBHOOK_URL to actually send anything).
 * @param {string} provider
 * @param {number} downtimeMs — how long the circuit was open before recovering
 */
export async function notifyProviderRecovered(provider, downtimeMs) {
  if (process.env.NOTIFY_ON_RECOVERY === "false") return;
  await Promise.allSettled([
    notifyDiscordRecovery(provider, downtimeMs),
  ]);
}

async function notifyDiscordRecovery(provider, downtimeMs) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;

  const downtimeSec = Math.round(downtimeMs / 1000);
  const payload = {
    username: "free-ai-router",
    embeds: [{
      title: "✅ Provider recovered",
      description: `**${provider}** passed its circuit-breaker recovery probe and is back to CLOSED (healthy) after ~${downtimeSec}s down.`,
      color: 0x44dd66,
      timestamp: new Date().toISOString(),
    }],
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logError(`Discord recovery webhook returned ${res.status}`);
    }
  } catch (err) {
    logError(`Discord recovery webhook failed: ${err.message}`);
  }
}
