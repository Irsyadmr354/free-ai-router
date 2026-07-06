/**
 * lib/db.js
 * Unified SQLite state store using Node.js built-in node:sqlite (Node 22+).
 *
 * Replaces all scattered in-memory Maps and JSON files:
 *   - cooldown-state.json       → provider_state table
 *   - benchmark (in-memory)     → benchmark_samples table
 *   - reputation (in-memory)    → provider_state table
 *   - budget-tracker (in-memory)→ provider_state table
 *   - usage-log.jsonl           → usage_log table
 *   - cache (in-memory)         → response_cache table
 *   - conversations              → conversations + messages tables
 *   - mab routing state          → mab_state table
 *
 * Two databases for separation of concerns + different retention policies:
 *   data/router.db       — operational state (small, fast, always open)
 *   data/conversations.db — conversation history (larger, with retention)
 *
 * Retention:
 *   - usage_log: keep 90 days, auto-archive older to data/archive/
 *   - conversations: keep full text 30 days, compressed summary 90 days
 *   - benchmark_samples: keep 7 days rolling window
 *   - response_cache: TTL-based, auto-expire
 *
 * Database path: DATA_DIR env var (default: ./data)
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { logError } from "./logger.js";

const DATA_DIR = resolve(process.env.DATA_DIR ?? "./data");
const ROUTER_DB_PATH = join(DATA_DIR, "router.db");
const CONV_DB_PATH = join(DATA_DIR, "conversations.db");

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}
if (!existsSync(join(DATA_DIR, "archive"))) {
  mkdirSync(join(DATA_DIR, "archive"), { recursive: true });
}

// ---------------------------------------------------------------------------
// Router database — operational state
// ---------------------------------------------------------------------------

let _routerDb = null;

export function getRouterDb() {
  if (_routerDb) return _routerDb;
  _routerDb = new DatabaseSync(ROUTER_DB_PATH);
  _routerDb.exec("PRAGMA journal_mode=WAL");
  _routerDb.exec("PRAGMA synchronous=NORMAL");
  _routerDb.exec("PRAGMA cache_size=4000");
  initRouterSchema(_routerDb);
  return _routerDb;
}

function initRouterSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_state (
      provider TEXT PRIMARY KEY,
      reputation_score REAL DEFAULT 70,
      last_429_at INTEGER,
      reputation_updated_at INTEGER DEFAULT (unixepoch() * 1000),
      cooldown_expiry INTEGER DEFAULT 0,
      budget_count INTEGER DEFAULT 0,
      budget_window_start INTEGER DEFAULT 0,
      circuit_state TEXT DEFAULT 'CLOSED',
      circuit_failures TEXT DEFAULT '[]',
      circuit_opened_at INTEGER,
      mab_successes INTEGER DEFAULT 0,
      mab_failures INTEGER DEFAULT 0,
      mab_total_reward REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS benchmark_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      ts INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      success INTEGER NOT NULL,
      status INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_benchmark_provider_ts ON benchmark_samples(provider, ts);

    CREATE TABLE IF NOT EXISTS response_cache (
      cache_key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      hits INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_cache_expires ON response_cache(expires_at);

    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ts_iso TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      session_id TEXT,
      latency_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log(ts);
    CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_log(provider);

    CREATE TABLE IF NOT EXISTS mab_state (
      provider TEXT PRIMARY KEY,
      successes INTEGER DEFAULT 0,
      failures INTEGER DEFAULT 0,
      total_reward REAL DEFAULT 0,
      last_updated INTEGER DEFAULT (unixepoch() * 1000)
    );
  `);
}

// ---------------------------------------------------------------------------
// Conversations database — message history with retention
// ---------------------------------------------------------------------------

let _convDb = null;

export function getConvDb() {
  if (_convDb) return _convDb;
  _convDb = new DatabaseSync(CONV_DB_PATH);
  _convDb.exec("PRAGMA journal_mode=WAL");
  _convDb.exec("PRAGMA synchronous=NORMAL");
  _convDb.exec("PRAGMA auto_vacuum=INCREMENTAL");
  initConvSchema(_convDb);
  return _convDb;
}

function initConvSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      title TEXT,
      provider TEXT,
      model TEXT,
      total_tokens INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      tier TEXT DEFAULT 'hot',
      summary TEXT,
      embedding_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at);
    CREATE INDEX IF NOT EXISTS idx_conv_tier ON conversations(tier);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      content_compressed INTEGER DEFAULT 0,
      token_count INTEGER DEFAULT 0,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, ts);
  `);
}

// ---------------------------------------------------------------------------
// Database size reporting
// ---------------------------------------------------------------------------

/**
 * Return current sizes of both databases.
 * @returns {{ routerMB: number, convMB: number, totalMB: number, archiveMB: number }}
 */
export function getDatabaseSizes() {
  const safeSize = (path) => { try { return statSync(path).size / (1024 * 1024); } catch { return 0; } };
  const routerMB = safeSize(ROUTER_DB_PATH);
  const convMB = safeSize(CONV_DB_PATH);

  let archiveMB = 0;
  const archiveDir = join(DATA_DIR, "archive");
  if (existsSync(archiveDir)) {
    for (const f of readdirSync(archiveDir)) {
      try { archiveMB += safeSize(join(archiveDir, f)); } catch { /* skip */ }
    }
  }

  return {
    routerMB: Math.round(routerMB * 100) / 100,
    convMB: Math.round(convMB * 100) / 100,
    archiveMB: Math.round(archiveMB * 100) / 100,
    totalMB: Math.round((routerMB + convMB + archiveMB) * 100) / 100,
  };
}

export { DATA_DIR };
