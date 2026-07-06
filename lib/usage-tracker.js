/**
 * lib/usage-tracker.js
 * Tracks token usage per provider — in-memory session stats + SQLite persistence.
 *
 * Replaces the append-only usage-log.jsonl with SQLite (router.db → usage_log).
 * The old JSONL file is still written if USAGE_LOG_JSONL=true for compatibility
 * with external tools that read it directly.
 */

import { appendFileSync } from "fs";
import { resolve } from "path";
import { getRouterDb } from "./db.js";
import { logError } from "./logger.js";

const JSONL_PATH = resolve(process.env.USAGE_LOG_PATH ?? "./usage-log.jsonl");
const JSONL_ENABLED = process.env.USAGE_LOG_JSONL !== "false"; // back-compat, default ON
const DB_ENABLED = process.env.USAGE_TRACKING !== "false";

/** @type {Map<string, { calls: number, promptTokens: number, completionTokens: number }>} */
const sessionStats = new Map();

/**
 * Record a successful call — in-memory session stats + SQLite + optional JSONL.
 */
export function recordUsage(provider, model, promptTokens = 0, completionTokens = 0, sessionId = null, latencyMs = null) {
  // In-memory
  const prev = sessionStats.get(provider) ?? { calls: 0, promptTokens: 0, completionTokens: 0 };
  sessionStats.set(provider, {
    calls: prev.calls + 1,
    promptTokens: prev.promptTokens + promptTokens,
    completionTokens: prev.completionTokens + completionTokens,
  });

  if (!DB_ENABLED) return;

  const now = Date.now();
  const tsIso = new Date(now).toISOString();
  const total = promptTokens + completionTokens;

  // SQLite write
  try {
    getRouterDb().prepare(`
      INSERT INTO usage_log (ts, ts_iso, provider, model, prompt_tokens, completion_tokens, total_tokens, session_id, latency_ms)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(now, tsIso, provider, model, promptTokens, completionTokens, total, sessionId ?? null, latencyMs ?? null);
  } catch (err) {
    logError(`usage-tracker: SQLite write failed — ${err.message}`);
  }

  // JSONL back-compat
  if (JSONL_ENABLED) {
    try {
      appendFileSync(JSONL_PATH, JSON.stringify({ ts: tsIso, provider, model, promptTokens, completionTokens, totalTokens: total }) + "\n", "utf8");
    } catch { /* non-fatal */ }
  }
}

/**
 * Return in-memory session stats.
 */
export function getSessionStats() {
  return [...sessionStats.entries()].map(([provider, s]) => ({
    provider,
    calls: s.calls,
    promptTokens: s.promptTokens,
    completionTokens: s.completionTokens,
    totalTokens: s.promptTokens + s.completionTokens,
  })).sort((a, b) => b.calls - a.calls);
}

/**
 * Query historical usage from SQLite.
 * @param {{ days?: number, provider?: string }} opts
 */
export function queryUsageHistory(opts = {}) {
  try {
    const db = getRouterDb();
    const since = opts.days ? Date.now() - opts.days * 86400000 : 0;
    let sql = "SELECT ts_iso, provider, model, prompt_tokens, completion_tokens, total_tokens, session_id FROM usage_log WHERE ts >= ?";
    const args = [since];
    if (opts.provider) { sql += " AND provider = ?"; args.push(opts.provider); }
    sql += " ORDER BY ts DESC LIMIT 1000";
    return db.prepare(sql).all(...args);
  } catch {
    return [];
  }
}
