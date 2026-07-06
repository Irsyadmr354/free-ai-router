/**
 * lib/data-retention.js
 * Automated tiered data retention for all SQLite tables.
 *
 * Runs on a configurable schedule and enforces size/age caps on:
 *   - benchmark_samples: rolling 7-day window (configurable)
 *   - response_cache: TTL-based expiry
 *   - semantic_cache: TTL-based expiry
 *   - usage_log: archive rows older than USAGE_RETENTION_DAYS to JSONL gz
 *   - mab_state: never deleted (tiny, important long-term data)
 *
 * Also enforces a hard DB size cap: if router.db exceeds MAX_ROUTER_DB_MB,
 * it aggressively prunes oldest benchmark samples and expired cache entries.
 *
 * Config (all via env):
 *   RETENTION_ENABLED=true
 *   RETENTION_INTERVAL_MS=3600000      (hourly)
 *   BENCHMARK_RETENTION_DAYS=7
 *   USAGE_RETENTION_DAYS=90
 *   MAX_ROUTER_DB_MB=100
 *   MAX_CONV_DB_MB=200
 */

import { getRouterDb, DATA_DIR, getDatabaseSizes } from "./db.js";
import { runRetention as runConvRetention } from "./conversations.js";
import { log, logError } from "./logger.js";
import { existsSync, statSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";

const ENABLED = process.env.RETENTION_ENABLED !== "false";
const INTERVAL_MS = parseInt(process.env.RETENTION_INTERVAL_MS ?? "3600000", 10);
const BENCHMARK_RETENTION_DAYS = parseInt(process.env.BENCHMARK_RETENTION_DAYS ?? "7", 10);
const USAGE_RETENTION_DAYS = parseInt(process.env.USAGE_RETENTION_DAYS ?? "90", 10);
const MAX_ROUTER_DB_MB = parseInt(process.env.MAX_ROUTER_DB_MB ?? "100", 10);

let retentionTimer = null;

/**
 * Run all retention tasks for router.db.
 */
export function runRouterRetention() {
  if (!ENABLED) return;
  try {
    const db = getRouterDb();
    const now = Date.now();
    const benchmarkCutoff = now - BENCHMARK_RETENTION_DAYS * 86400000;
    const usageCutoff = now - USAGE_RETENTION_DAYS * 86400000;

    // 1. Prune old benchmark samples
    const benchmarkResult = db.prepare(
      "DELETE FROM benchmark_samples WHERE ts < ?"
    ).run(benchmarkCutoff);

    // 2. Expire response cache
    const cacheResult = db.prepare(
      "DELETE FROM response_cache WHERE expires_at < ?"
    ).run(now);

    // 3. Expire semantic cache (if table exists)
    try {
      db.prepare("DELETE FROM semantic_cache WHERE expires_at < ?").run(now);
    } catch { /* table may not exist if semantic cache never used */ }

    // 4. Archive old usage log entries to JSONL file, then delete from DB
    const oldUsage = db.prepare(
      "SELECT ts_iso, provider, model, prompt_tokens, completion_tokens, total_tokens, session_id FROM usage_log WHERE ts < ? ORDER BY ts"
    ).all(usageCutoff);

    if (oldUsage.length > 0) {
      const month = new Date(usageCutoff).toISOString().slice(0, 7);
      const archivePath = join(DATA_DIR, "archive", `usage_${month}.jsonl`);
      const lines = oldUsage.map((r) => JSON.stringify(r)).join("\n") + "\n";
      appendFileSync(archivePath, lines, "utf8");
      db.prepare("DELETE FROM usage_log WHERE ts < ?").run(usageCutoff);
    }

    // 5. Hard DB size enforcement
    const sizes = getDatabaseSizes();
    if (sizes.routerMB > MAX_ROUTER_DB_MB) {
      logError(`data-retention: router.db is ${sizes.routerMB}MB > ${MAX_ROUTER_DB_MB}MB limit — aggressive pruning`);
      // Delete oldest 20% of benchmark samples
      const totalSamples = db.prepare("SELECT COUNT(*) as c FROM benchmark_samples").get().c;
      if (totalSamples > 0) {
        const keep = Math.floor(totalSamples * 0.8);
        db.prepare(
          "DELETE FROM benchmark_samples WHERE id NOT IN (SELECT id FROM benchmark_samples ORDER BY ts DESC LIMIT ?)"
        ).run(keep);
      }
      // Delete all expired cache regardless of TTL extension
      db.prepare("DELETE FROM response_cache WHERE hits = 0").run();
    }

    // 6. VACUUM incrementally to reclaim space
    db.exec("PRAGMA incremental_vacuum(200)");

    const totalPruned = benchmarkResult.changes + cacheResult.changes + oldUsage.length;
    if (totalPruned > 0) {
      log(`data-retention: pruned ${benchmarkResult.changes} benchmark samples, ${cacheResult.changes} cache entries, archived ${oldUsage.length} usage records`);
    }
  } catch (err) {
    logError(`data-retention: runRouterRetention failed — ${err.message}`);
  }
}

/**
 * Run all retention tasks (router + conversations).
 */
export function runAllRetention() {
  runRouterRetention();
  runConvRetention();
}

/**
 * Start the background retention scheduler.
 * Call once at server startup.
 */
export function startRetentionScheduler() {
  if (!ENABLED || retentionTimer) return;
  // First run 60s after startup (don't block boot)
  setTimeout(() => runAllRetention(), 60_000);
  retentionTimer = setInterval(() => runAllRetention(), INTERVAL_MS);
  retentionTimer.unref();
  log(`data-retention: scheduler started (interval: ${INTERVAL_MS / 1000}s)`);
}

/**
 * Return retention configuration and last-known DB sizes.
 */
export function getRetentionStatus() {
  const sizes = getDatabaseSizes();
  return {
    enabled: ENABLED,
    intervalSeconds: INTERVAL_MS / 1000,
    benchmarkRetentionDays: BENCHMARK_RETENTION_DAYS,
    usageRetentionDays: USAGE_RETENTION_DAYS,
    maxRouterDbMB: MAX_ROUTER_DB_MB,
    currentSizes: sizes,
  };
}
