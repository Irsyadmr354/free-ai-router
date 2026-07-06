/**
 * lib/usage-tracker.js
 * Tracks token usage and call counts per provider per session,
 * and appends a JSON record to usage-log.jsonl on each successful call.
 *
 * The log file lives at USAGE_LOG_PATH env var, defaulting to ./usage-log.jsonl.
 * Set USAGE_TRACKING=false to disable file writes (in-memory stats still kept).
 */

import { appendFileSync } from "fs";
import { resolve } from "path";

const LOG_PATH = resolve(process.env.USAGE_LOG_PATH ?? "./usage-log.jsonl");
const FILE_ENABLED = process.env.USAGE_TRACKING !== "false";

/** @type {Map<string, { calls: number, promptTokens: number, completionTokens: number }>} */
const sessionStats = new Map();

/**
 * Record a successful call. Writes a JSONL line and updates in-memory totals.
 * @param {string} provider
 * @param {string} model
 * @param {number} promptTokens   - 0 if unknown (provider didn't return usage)
 * @param {number} completionTokens - 0 if unknown
 */
export function recordUsage(provider, model, promptTokens = 0, completionTokens = 0) {
  // Update in-memory session stats
  const prev = sessionStats.get(provider) ?? { calls: 0, promptTokens: 0, completionTokens: 0 };
  sessionStats.set(provider, {
    calls: prev.calls + 1,
    promptTokens: prev.promptTokens + promptTokens,
    completionTokens: prev.completionTokens + completionTokens,
  });

  if (!FILE_ENABLED) return;

  const record = {
    ts: new Date().toISOString(),
    provider,
    model,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };

  try {
    appendFileSync(LOG_PATH, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Non-fatal — don't crash the server if the log can't be written
  }
}

/**
 * Return in-memory usage stats for this session.
 * @returns {Array<{ provider: string, calls: number, promptTokens: number, completionTokens: number, totalTokens: number }>}
 */
export function getSessionStats() {
  const result = [];
  for (const [provider, stats] of sessionStats.entries()) {
    result.push({
      provider,
      calls: stats.calls,
      promptTokens: stats.promptTokens,
      completionTokens: stats.completionTokens,
      totalTokens: stats.promptTokens + stats.completionTokens,
    });
  }
  return result.sort((a, b) => b.calls - a.calls);
}
