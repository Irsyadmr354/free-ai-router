/**
 * lib/benchmark.js
 * Per-provider latency and success rate tracking.
 * Reads/writes from SQLite (router.db → benchmark_samples) for persistence.
 * In-memory cache layer for fast reads — DB is source of truth.
 */

import { getRouterDb } from "./db.js";
import { logError } from "./logger.js";

const MAX_SAMPLES = parseInt(process.env.BENCHMARK_MAX_SAMPLES ?? "500", 10);

/** In-memory cache to avoid hitting DB on every reorder */
/** @type {Map<string, Array<{ts:number,latencyMs:number,success:boolean,status:number|null}>>} */
const memCache = new Map();
let cacheLoaded = false;

function ensureLoaded() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const db = getRouterDb();
    const rows = db.prepare(
      "SELECT provider, ts, latency_ms, success, status FROM benchmark_samples ORDER BY ts DESC LIMIT ?"
    ).all(MAX_SAMPLES * 10);
    for (const row of rows) {
      const list = memCache.get(row.provider) ?? [];
      if (list.length < MAX_SAMPLES) list.push({ ts: row.ts, latencyMs: row.latency_ms, success: !!row.success, status: row.status });
      memCache.set(row.provider, list);
    }
  } catch { /* start fresh if DB unavailable */ }
}

export function recordBenchmark(provider, latencyMs, success, status = null) {
  ensureLoaded();
  // Update in-memory
  const list = memCache.get(provider) ?? [];
  list.push({ ts: Date.now(), latencyMs, success, status });
  if (list.length > MAX_SAMPLES) list.shift();
  memCache.set(provider, list);
  // Write to DB (best-effort)
  try {
    getRouterDb().prepare(
      "INSERT INTO benchmark_samples (provider, ts, latency_ms, success, status) VALUES (?,?,?,?,?)"
    ).run(provider, Date.now(), latencyMs, success ? 1 : 0, status);
  } catch (err) {
    logError(`benchmark: DB write failed — ${err.message}`);
  }
}

export function getBenchmark(provider) {
  ensureLoaded();
  const list = memCache.get(provider) ?? [];
  if (!list.length) return { provider, calls: 0, avgLatencyMs: null, successRate: null, p95LatencyMs: null };
  const latencies = list.map((s) => s.latencyMs).sort((a, b) => a - b);
  const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))];
  const successRate = Math.round((list.filter((s) => s.success).length / list.length) * 1000) / 1000;
  return { provider, calls: list.length, avgLatencyMs: avg, p95LatencyMs: p95, successRate };
}

export function getAllBenchmarks(providers) {
  return providers.map(getBenchmark).sort((a, b) => {
    if (a.avgLatencyMs === null) return 1;
    if (b.avgLatencyMs === null) return -1;
    return (a.avgLatencyMs / Math.max(a.successRate, 0.01)) - (b.avgLatencyMs / Math.max(b.successRate, 0.01));
  });
}

export function sortByBenchmark(order) {
  const withData = order.filter((p) => (memCache.get(p)?.length ?? 0) > 0);
  const withoutData = order.filter((p) => !(memCache.get(p)?.length ?? 0));
  return [...getAllBenchmarks(withData).map((b) => b.provider), ...withoutData];
}
