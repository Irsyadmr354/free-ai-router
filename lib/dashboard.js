/**
 * lib/dashboard.js
 * Minimal read-only web dashboard — no Express dependency, just Node's
 * built-in http module, to avoid adding weight to a package meant to stay
 * light. Shows provider status, cooldowns, usage stats, and recent log
 * lines, auto-refreshing every few seconds.
 *
 * Enable via DASHBOARD_ENABLED=true. Port via DASHBOARD_PORT (default 4319).
 * Runs on its own port, independent of the MCP stdio transport.
 */

import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { log, logError } from "./logger.js";

export function isDashboardEnabled() {
  return process.env.DASHBOARD_ENABLED === "true";
}

function getPort() {
  const val = parseInt(process.env.DASHBOARD_PORT ?? "", 10);
  return isNaN(val) ? 4319 : val;
}

function renderHtml(data) {
  const rows = data.providers.map((p) => `
    <tr>
      <td>${p.provider}</td>
      <td><span class="badge ${p.status.startsWith('active') ? 'ok' : p.status.startsWith('cooldown') ? 'warn' : 'off'}">${p.status}</span></td>
      <td>${p.reputation ?? '—'}</td>
      <td>${p.avgLatencyMs !== null ? p.avgLatencyMs + 'ms' : '—'}</td>
      <td>${p.calls}</td>
    </tr>`).join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>free-ai-router dashboard</title>
<meta http-equiv="refresh" content="5">
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f1117; color: #e6e6e6; margin: 0; padding: 24px; }
  h1 { font-size: 18px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #262a35; font-size: 14px; }
  th { color: #9aa1b1; font-weight: 500; }
  .badge { padding: 2px 8px; border-radius: 4px; font-size: 12px; }
  .badge.ok { background: #16382a; color: #4ade80; }
  .badge.warn { background: #3a2f14; color: #facc15; }
  .badge.off { background: #2a2a2a; color: #999; }
  .stat { display: inline-block; margin-right: 24px; }
  .stat b { font-size: 20px; display: block; }
  pre { background: #161822; padding: 12px; border-radius: 6px; font-size: 12px; overflow-x: auto; max-height: 240px; }
</style>
</head>
<body>
  <h1>free-ai-router — live status</h1>
  <div class="stat"><b>${data.totalCalls}</b>total calls (session)</div>
  <div class="stat"><b>${data.totalTokens}</b>total tokens (session)</div>
  <div class="stat"><b>${data.cacheEntries}</b>cache entries</div>
  <table>
    <tr><th>Provider</th><th>Status</th><th>Reputation</th><th>Avg latency</th><th>Calls</th></tr>
    ${rows}
  </table>
  <h1 style="margin-top:24px">Recent log</h1>
  <pre>${data.recentLog}</pre>
</body>
</html>`;
}

let server = null;

/**
 * Start the dashboard HTTP server.
 * @param {() => object} getSnapshot - returns the current data object to render
 */
export function startDashboard(getSnapshot) {
  if (!isDashboardEnabled()) return;
  if (server) return;

  const port = getPort();
  server = createServer((req, res) => {
    if (req.url === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getSnapshot()));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderHtml(getSnapshot()));
  });

  server.on("error", (err) => {
    logError(`Dashboard server error: ${err.message}`);
  });

  server.listen(port, () => {
    log(`Dashboard listening at http://localhost:${port}`);
  });
}

export function stopDashboard() {
  if (server) {
    server.close();
    server = null;
  }
}

export function tailLog(lines = 50) {
  // Best-effort: the logger writes to stderr only, so there's no file to
  // tail by default. If USAGE_LOG_PATH is set, show the tail of that instead
  // as a proxy for "recent activity".
  const path = resolve(process.env.USAGE_LOG_PATH ?? "./usage-log.jsonl");
  if (!existsSync(path)) return "(no usage log yet)";
  try {
    const raw = readFileSync(path, "utf8").trim().split("\n");
    return raw.slice(-lines).join("\n") || "(empty)";
  } catch {
    return "(could not read log)";
  }
}
