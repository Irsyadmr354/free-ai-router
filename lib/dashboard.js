/**
 * lib/dashboard.js
 * Read-only web dashboard — no Express/React dependency, just Node's built-in
 * http module + a single self-contained HTML/CSS/JS document, to keep this
 * package light. Shows provider status, budgets, circuit breakers, cache,
 * and recent activity, live-refreshing via a small polling script (fetches
 * /api/status every few seconds and patches the DOM — no full page reload
 * flicker like a <meta refresh> would cause).
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

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtNum(n) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("en-US");
}

function fmtPct(n) {
  if (n === null || n === undefined) return "—";
  return `${Math.round(n * 100)}%`;
}

function fmtUptime(seconds) {
  if (!seconds || seconds < 0) return "0s";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!d && !h) parts.push(`${s}s`);
  return parts.join(" ");
}

/**
 * Classify a provider's status string into a badge variant + short label.
 */
function statusMeta(status) {
  if (status === "active") return { variant: "ok", label: "Active", icon: "●" };
  if (status === "no-key") return { variant: "off", label: "No key", icon: "○" };
  if (status.startsWith("cooldown")) return { variant: "warn", label: status.replace("cooldown ", "Cooldown "), icon: "◐" };
  if (status.startsWith("circuit-open")) return { variant: "bad", label: status.replace("circuit-open", "Circuit open"), icon: "✕" };
  return { variant: "off", label: status, icon: "○" };
}

function renderProviderCard(p) {
  const meta = statusMeta(p.status);
  const budgetPct = p.budget?.limit ? Math.min(100, Math.round((p.budget.count / p.budget.limit) * 100)) : null;
  const budgetBar = budgetPct !== null ? `
    <div class="budget">
      <div class="budget-track"><div class="budget-fill ${budgetPct >= 90 ? 'danger' : budgetPct >= 70 ? 'warn' : ''}" style="width:${budgetPct}%"></div></div>
      <div class="budget-label">${fmtNum(p.budget.count)} / ${fmtNum(p.budget.limit)} per ${esc(p.budget.window)} · ${budgetPct}%</div>
    </div>` : `<div class="budget-label muted">Unlimited / unknown budget</div>`;

  const repPct = Math.max(0, Math.min(100, p.reputation ?? 70));
  const repColor = repPct >= 80 ? "#4ade80" : repPct >= 50 ? "#facc15" : "#f87171";

  const flagChips = [
    p.supportsImages ? '<span class="chip">🖼️ images</span>' : "",
    p.supportsTools ? '<span class="chip">🔧 tools</span>' : "",
    p.supportsStream ? '<span class="chip">⏱ stream</span>' : "",
  ].filter(Boolean).join("");

  return `
  <div class="card provider-card" data-provider="${esc(p.provider)}">
    <div class="provider-head">
      <div class="provider-name">${esc(p.provider)}</div>
      <span class="badge ${meta.variant}">${meta.icon} ${esc(meta.label)}</span>
    </div>
    <div class="provider-meta">${flagChips || '<span class="chip muted">no special features</span>'}</div>
    <div class="rep-row">
      <div class="rep-ring" style="--pct:${repPct}; --color:${repColor}">
        <span>${repPct}</span>
      </div>
      <div class="rep-stats">
        <div class="kv"><span>Reputation</span><b>${repPct}/100</b></div>
        <div class="kv"><span>Avg latency</span><b>${p.avgLatencyMs !== null && p.avgLatencyMs !== undefined ? fmtNum(p.avgLatencyMs) + 'ms' : '—'}</b></div>
        <div class="kv"><span>Success rate</span><b>${fmtPct(p.successRate)}</b></div>
        <div class="kv"><span>Calls (session)</span><b>${fmtNum(p.calls)}</b></div>
      </div>
    </div>
    ${budgetBar}
    <div class="provider-foot muted">default model: <code>${esc(p.defaultModel ?? '—')}</code></div>
  </div>`;
}

function renderHtml(data) {
  const cards = data.providers.map(renderProviderCard).join("\n");
  const activeCount = data.providers.filter((p) => p.status === "active").length;
  const cacheHitRate = data.cache?.hitRate !== null && data.cache?.hitRate !== undefined ? fmtPct(data.cache.hitRate) : "—";
  const circuitRows = (data.circuits ?? []).filter((c) => c.state !== "CLOSED");
  const circuitSection = circuitRows.length
    ? `<div class="card alert-card">
        <div class="card-title">⚠️ Circuit breakers open</div>
        ${circuitRows.map((c) => `<div class="kv-row"><span>${esc(c.provider)}</span><span class="badge bad">${esc(c.state)} · ${c.remainingSeconds}s</span></div>`).join("")}
      </div>`
    : "";
  const queueSection = data.queueDepth > 0
    ? `<div class="card alert-card warn-card">
        <div class="card-title">⏳ Request queue</div>
        <div class="kv-row"><span>Waiting for provider recovery</span><span class="badge warn">${data.queueDepth} queued</span></div>
      </div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>free-ai-router — dashboard</title>
<style>
  :root {
    --bg: #0a0b0f;
    --bg-elevated: #12141b;
    --bg-card: #14161e;
    --border: #23262f;
    --text: #e8e9ed;
    --text-dim: #8b8f9c;
    --accent: #7c9eff;
    --accent-soft: #7c9eff22;
    --ok: #4ade80;
    --ok-bg: #14301f;
    --warn: #facc15;
    --warn-bg: #362b0d;
    --bad: #f87171;
    --bad-bg: #3a1616;
    --off: #6b7280;
    --off-bg: #1c1e26;
    --radius: 14px;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    background: radial-gradient(circle at 15% 0%, #151826 0%, var(--bg) 45%);
    color: var(--text);
    margin: 0;
    padding: 32px 40px 64px;
    min-height: 100vh;
  }
  .topbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; margin-bottom: 28px; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .brand-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 12px var(--ok); animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  h1 { font-size: 20px; font-weight: 650; margin: 0; letter-spacing: -0.01em; }
  .subtitle { color: var(--text-dim); font-size: 13px; margin-top: 2px; }
  .live-indicator { font-size: 12px; color: var(--text-dim); display: flex; align-items: center; gap: 6px; }

  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin-bottom: 24px; }
  .stat-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
  .stat-card .stat-value { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
  .stat-card .stat-label { font-size: 12.5px; color: var(--text-dim); margin-top: 4px; }
  .stat-card.accent .stat-value { color: var(--accent); }

  .section-title { font-size: 13px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-dim); margin: 28px 0 12px; }

  .alert-stack { display: grid; gap: 12px; margin-bottom: 8px; }
  .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
  .alert-card { border-color: #4a2020; background: linear-gradient(180deg, #1c1216, var(--bg-card)); }
  .alert-card.warn-card { border-color: #4a3a12; background: linear-gradient(180deg, #1f1a0e, var(--bg-card)); }
  .card-title { font-weight: 600; font-size: 14px; margin-bottom: 10px; }
  .kv-row { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; font-size: 13.5px; }

  .provider-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
  .provider-card { display: flex; flex-direction: column; gap: 14px; transition: border-color 0.2s; }
  .provider-card:hover { border-color: #343945; }
  .provider-head { display: flex; align-items: center; justify-content: space-between; }
  .provider-name { font-weight: 650; font-size: 15px; text-transform: capitalize; }
  .provider-meta { display: flex; gap: 6px; flex-wrap: wrap; min-height: 22px; }
  .chip { font-size: 11px; background: var(--bg-elevated); border: 1px solid var(--border); padding: 2px 8px; border-radius: 20px; color: var(--text-dim); }
  .chip.muted { opacity: 0.5; }

  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .badge.ok { background: var(--ok-bg); color: var(--ok); }
  .badge.warn { background: var(--warn-bg); color: var(--warn); }
  .badge.bad { background: var(--bad-bg); color: var(--bad); }
  .badge.off { background: var(--off-bg); color: var(--off); }

  .rep-row { display: flex; align-items: center; gap: 16px; }
  .rep-ring {
    --pct: 70; --color: #facc15;
    width: 56px; height: 56px; border-radius: 50%; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 15px; font-weight: 700;
    background: conic-gradient(var(--color) calc(var(--pct) * 1%), var(--bg-elevated) 0);
    position: relative;
  }
  .rep-ring::before { content: ""; position: absolute; inset: 5px; background: var(--bg-card); border-radius: 50%; }
  .rep-ring span { position: relative; z-index: 1; }
  .rep-stats { flex: 1; display: grid; gap: 3px; }
  .kv { display: flex; align-items: baseline; justify-content: space-between; font-size: 12.5px; }
  .kv span { color: var(--text-dim); }
  .kv b { font-weight: 600; }

  .budget-track { height: 6px; border-radius: 4px; background: var(--bg-elevated); overflow: hidden; }
  .budget-fill { height: 100%; background: var(--accent); border-radius: 4px; transition: width 0.3s; }
  .budget-fill.warn { background: var(--warn); }
  .budget-fill.danger { background: var(--bad); }
  .budget-label { font-size: 11.5px; color: var(--text-dim); margin-top: 6px; }
  .budget-label.muted { opacity: 0.6; }

  .provider-foot { font-size: 11.5px; padding-top: 10px; border-top: 1px solid var(--border); }
  .provider-foot code { background: var(--bg-elevated); padding: 1px 6px; border-radius: 4px; font-size: 11px; }
  .muted { color: var(--text-dim); }

  .bottom-grid { display: grid; grid-template-columns: 1.3fr 1fr; gap: 16px; margin-top: 12px; }
  @media (max-width: 820px) { .bottom-grid { grid-template-columns: 1fr; } }
  pre.log { background: var(--bg-elevated); padding: 14px; border-radius: 10px; font-size: 12px; overflow: auto; max-height: 260px; margin: 0; color: var(--text-dim); line-height: 1.6; border: 1px solid var(--border); }

  footer { margin-top: 32px; font-size: 11.5px; color: var(--text-dim); text-align: center; }
  footer a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
  <div class="topbar">
    <div class="brand">
      <span class="brand-dot"></span>
      <div>
        <h1>free-ai-router</h1>
        <div class="subtitle">${activeCount}/${data.providers.length} providers active · uptime ${fmtUptime(data.uptimeSeconds)}</div>
      </div>
    </div>
    <div class="live-indicator" id="live-indicator">↻ refreshing every 4s</div>
  </div>

  <div class="stat-grid">
    <div class="stat-card accent"><div class="stat-value" id="stat-calls">${fmtNum(data.totalCalls)}</div><div class="stat-label">Total calls (session)</div></div>
    <div class="stat-card"><div class="stat-value" id="stat-tokens">${fmtNum(data.totalTokens)}</div><div class="stat-label">Total tokens (session)</div></div>
    <div class="stat-card"><div class="stat-value" id="stat-cache">${fmtNum(data.cache?.entries)}</div><div class="stat-label">Cache entries</div></div>
    <div class="stat-card"><div class="stat-value" id="stat-hitrate">${cacheHitRate}</div><div class="stat-label">Cache hit rate</div></div>
    <div class="stat-card"><div class="stat-value" id="stat-queue">${fmtNum(data.queueDepth ?? 0)}</div><div class="stat-label">Queued requests</div></div>
  </div>

  <div class="alert-stack">
    ${circuitSection}
    ${queueSection}
  </div>

  <div class="section-title">Providers</div>
  <div class="provider-grid" id="provider-grid">
    ${cards}
  </div>

  <div class="bottom-grid">
    <div>
      <div class="section-title">Recent log</div>
      <pre class="log" id="recent-log">${esc(data.recentLog)}</pre>
    </div>
    <div>
      <div class="section-title">Config warnings</div>
      <div class="card">
        ${data.warnings?.length
          ? data.warnings.map((w) => `<div class="kv-row"><span>⚠️ ${esc(w)}</span></div>`).join("")
          : '<div class="muted">No config warnings — everything looks good.</div>'}
      </div>
    </div>
  </div>

  <footer>free-ai-router · <a href="/api/status" target="_blank">raw JSON</a> · updates automatically, no need to refresh</footer>

<script>
(function() {
  var indicator = document.getElementById('live-indicator');
  function fmtNum(n) { if (n === null || n === undefined) return '—'; return Number(n).toLocaleString('en-US'); }
  function fmtPct(n) { if (n === null || n === undefined) return '—'; return Math.round(n * 100) + '%'; }

  async function refresh() {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) throw new Error('bad status');
      const data = await res.json();
      document.getElementById('stat-calls').textContent = fmtNum(data.totalCalls);
      document.getElementById('stat-tokens').textContent = fmtNum(data.totalTokens);
      document.getElementById('stat-cache').textContent = fmtNum(data.cache && data.cache.entries);
      document.getElementById('stat-hitrate').textContent = (data.cache && data.cache.hitRate != null) ? fmtPct(data.cache.hitRate) : '—';
      document.getElementById('stat-queue').textContent = fmtNum(data.queueDepth || 0);
      indicator.textContent = '↻ updated ' + new Date().toLocaleTimeString();
      indicator.style.color = '';
      // Full re-render of provider cards/alerts is intentionally left to a
      // periodic full page fetch fallback below to avoid duplicating all the
      // HTML-building logic in client JS — the stat bar above already gives
      // live numbers between full reloads.
    } catch (err) {
      indicator.textContent = '⚠ connection lost — retrying…';
      indicator.style.color = 'var(--bad)';
    }
  }

  setInterval(refresh, 4000);
  // Full reload every 20s so provider cards (status/reputation/budget) stay accurate too.
  setInterval(function() { window.location.reload(); }, 20000);
})();
</script>
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
