/**
 * lib/benchmark.js
 * Records per-call latency (and success/fail) for every provider call,
 * kept in-memory for the life of the process, so get_benchmarks can report
 * average latency and success rate per provider — and reputation.js can
 * use the same data to compute a reliability score.
 */

const MAX_SAMPLES_PER_PROVIDER = 500;

/** @type {Map<string, Array<{ ts: number, latencyMs: number, success: boolean, status: number|null }>>} */
const samples = new Map();

/**
 * Record one provider call outcome.
 * @param {string} provider
 * @param {number} latencyMs
 * @param {boolean} success
 * @param {number|null} [status]
 */
export function recordBenchmark(provider, latencyMs, success, status = null) {
  const list = samples.get(provider) ?? [];
  list.push({ ts: Date.now(), latencyMs, success, status });
  if (list.length > MAX_SAMPLES_PER_PROVIDER) list.shift();
  samples.set(provider, list);
}

/**
 * Get aggregate benchmark stats for one provider.
 * @param {string} provider
 */
export function getBenchmark(provider) {
  const list = samples.get(provider) ?? [];
  if (!list.length) {
    return { provider, calls: 0, avgLatencyMs: null, successRate: null, p95LatencyMs: null };
  }
  const latencies = list.map((s) => s.latencyMs).sort((a, b) => a - b);
  const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  const p95Index = Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95));
  const successRate = list.filter((s) => s.success).length / list.length;

  return {
    provider,
    calls: list.length,
    avgLatencyMs: avg,
    p95LatencyMs: latencies[p95Index],
    successRate: Math.round(successRate * 1000) / 1000,
  };
}

/**
 * Get benchmark stats for a set of providers, sorted best (lowest avg latency,
 * weighted by success rate) first.
 * @param {string[]} providers
 */
export function getAllBenchmarks(providers) {
  const results = providers.map(getBenchmark);
  return results.sort((a, b) => {
    // Providers with no data sort last.
    if (a.avgLatencyMs === null) return 1;
    if (b.avgLatencyMs === null) return -1;
    // Effective latency penalizes low success rate.
    const aEff = a.avgLatencyMs / Math.max(a.successRate, 0.01);
    const bEff = b.avgLatencyMs / Math.max(b.successRate, 0.01);
    return aEff - bEff;
  });
}

/**
 * Reorder a provider list by observed performance (lowest effective latency
 * first). Providers with no samples yet keep their original relative order,
 * appended after providers that do have data.
 * @param {string[]} order
 * @returns {string[]}
 */
export function sortByBenchmark(order) {
  const withData = order.filter((p) => (samples.get(p)?.length ?? 0) > 0);
  const withoutData = order.filter((p) => !(samples.get(p)?.length ?? 0));
  const sorted = getAllBenchmarks(withData).map((b) => b.provider);
  return [...sorted, ...withoutData];
}
