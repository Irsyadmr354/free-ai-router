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
