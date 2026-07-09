/**
 * lib/report.js
 * Reads usage-log.jsonl and produces aggregate summaries — used by both
 * summarize_usage_log and export_usage_report tools.
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

// Rough public per-1M-token cost estimates, USD, used only to give a sense
// of "what this would have cost" had it not been free-tier. Not billed.
const COST_PER_MILLION_TOKENS_USD = {
  gemini: 0,
  groq: 0,
  openrouter: 0,
  cloudflare: 0,
  cohere: 0,
  mistral: 0,
};

function loadRecords() {
  const path = resolve(process.env.USAGE_LOG_PATH ?? "./usage-log.jsonl");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const records = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

function dayKey(iso) {
  return iso.slice(0, 10); // YYYY-MM-DD
}

function hourOf(iso) {
  return new Date(iso).getHours();
}

/**
 * Aggregate usage-log.jsonl into per-provider and per-day/week summaries.
 * @param {{ since?: Date }} [opts]
 */
export function summarizeUsage({ since } = {}) {
  let records = loadRecords();
  if (since) records = records.filter((r) => new Date(r.ts) >= since);

  const byProvider = new Map();
  const byDay = new Map();
  const hourCounts = new Array(24).fill(0);

  for (const r of records) {
    const p = byProvider.get(r.provider) ?? { calls: 0, totalTokens: 0 };
    p.calls += 1;
    p.totalTokens += r.totalTokens ?? 0;
    byProvider.set(r.provider, p);

    const d = dayKey(r.ts);
    const day = byDay.get(d) ?? { calls: 0, totalTokens: 0 };
    day.calls += 1;
    day.totalTokens += r.totalTokens ?? 0;
    byDay.set(d, day);

    hourCounts[hourOf(r.ts)] += 1;
  }

  const totalCalls = records.length;
  const totalTokens = records.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0);
  const mostUsedProvider = [...byProvider.entries()].sort((a, b) => b[1].calls - a[1].calls)[0]?.[0] ?? null;
  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));

  return {
    totalCalls,
    totalTokens,
    mostUsedProvider,
    peakHour: totalCalls ? peakHour : null,
    byProvider: Object.fromEntries(byProvider),
    byDay: Object.fromEntries([...byDay.entries()].sort()),
  };
}

/**
 * Build a Markdown report string from usage-log.jsonl.
 */
export function buildMarkdownReport() {
  const summary = summarizeUsage();
  const lines = [
    "# Usage Report — free-ai-router",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    `**Total calls:** ${summary.totalCalls}`,
    `**Total tokens:** ${summary.totalTokens}`,
    `**Most used provider:** ${summary.mostUsedProvider ?? "—"}`,
    `**Peak hour (local):** ${summary.peakHour !== null ? `${summary.peakHour}:00` : "—"}`,
    "",
    "## By provider",
    "",
    "| Provider | Calls | Total tokens |",
    "|---|---|---|",
    ...Object.entries(summary.byProvider).map(([p, s]) => `| ${p} | ${s.calls} | ${s.totalTokens} |`),
    "",
    "## By day",
    "",
    "| Day | Calls | Total tokens |",
    "|---|---|---|",
    ...Object.entries(summary.byDay).map(([d, s]) => `| ${d} | ${s.calls} | ${s.totalTokens} |`),
    "",
    "> Note: all providers used here are free-tier — cost estimate is $0.00.",
  ];
  return lines.join("\n");
}

/**
 * Build a CSV report string from usage-log.jsonl (one row per log line).
 */
export function buildCsvReport() {
  const path = resolve(process.env.USAGE_LOG_PATH ?? "./usage-log.jsonl");
  if (!existsSync(path)) return "ts,provider,model,promptTokens,completionTokens,totalTokens\n";

  const raw = readFileSync(path, "utf8");
  const rows = ["ts,provider,model,promptTokens,completionTokens,totalTokens"];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      rows.push([r.ts, r.provider, r.model, r.promptTokens ?? 0, r.completionTokens ?? 0, r.totalTokens ?? 0].join(","));
    } catch {
      // skip
    }
  }
  return rows.join("\n");
}
