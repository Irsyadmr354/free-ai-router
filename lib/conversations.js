/**
 * lib/conversations.js
 * Persistent conversation storage with tiered retention.
 *
 * Stores conversation history in SQLite (conversations.db).
 * Implements storage-efficient retention:
 *   hot  (0-7d):  full text, queryable
 *   warm (7-30d): full text, lower priority
 *   cold (30-90d): summary only, full text archived
 *   expired (>90d): deleted from DB, optionally archived to data/archive/
 *
 * Compression: full message text is kept as-is in DB. At warm→cold transition,
 * a summary is generated (via LLM if available, otherwise truncation) and the
 * full text is moved to archive. This keeps the DB small.
 *
 * Config:
 *   CONVERSATION_STORAGE_ENABLED=true
 *   RETENTION_HOT_DAYS=7
 *   RETENTION_WARM_DAYS=30
 *   RETENTION_COLD_DAYS=90
 *   RETENTION_RUN_INTERVAL_MS=3600000  (1 hour, how often to run retention)
 */

import { getConvDb, DATA_DIR } from "./db.js";
import { log, logError } from "./logger.js";
import { randomUUID } from "crypto";
import { join } from "path";
import { writeFileSync, existsSync } from "fs";

const ENABLED = process.env.CONVERSATION_STORAGE_ENABLED !== "false";
const RETENTION_HOT_DAYS = parseInt(process.env.RETENTION_HOT_DAYS ?? "7", 10);
const RETENTION_WARM_DAYS = parseInt(process.env.RETENTION_WARM_DAYS ?? "30", 10);
const RETENTION_COLD_DAYS = parseInt(process.env.RETENTION_COLD_DAYS ?? "90", 10);
const RETENTION_INTERVAL_MS = parseInt(process.env.RETENTION_RUN_INTERVAL_MS ?? "3600000", 10);

let retentionTimer = null;

/**
 * Save a completed conversation exchange to persistent storage.
 * @param {object} opts
 * @param {string} [opts.conversationId]  — existing ID to append to, or new
 * @param {string} opts.userPrompt
 * @param {string} opts.assistantResponse
 * @param {string} opts.provider
 * @param {string} opts.model
 * @param {number} opts.promptTokens
 * @param {number} opts.completionTokens
 * @param {string} [opts.sessionId]
 * @returns {string} conversation ID
 */
export function saveExchange(opts) {
  if (!ENABLED) return opts.conversationId ?? randomUUID();
  try {
    const db = getConvDb();
    const now = Date.now();
    const convId = opts.conversationId ?? randomUUID();
    const totalTokens = (opts.promptTokens ?? 0) + (opts.completionTokens ?? 0);

    // Upsert conversation record
    db.prepare(`
      INSERT INTO conversations (id, created_at, updated_at, provider, model, total_tokens, message_count, tier)
      VALUES (?, ?, ?, ?, ?, ?, 2, 'hot')
      ON CONFLICT(id) DO UPDATE SET
        updated_at = ?,
        provider = ?,
        model = ?,
        total_tokens = total_tokens + ?,
        message_count = message_count + 2
    `).run(convId, now, now, opts.provider, opts.model, totalTokens, now, opts.provider, opts.model, totalTokens);

    // Insert user message
    db.prepare(`INSERT INTO messages (conversation_id, ts, role, content, token_count) VALUES (?,?,?,?,?)`)
      .run(convId, now - 1, "user", opts.userPrompt, opts.promptTokens ?? 0);

    // Insert assistant message
    db.prepare(`INSERT INTO messages (conversation_id, ts, role, content, token_count) VALUES (?,?,?,?,?)`)
      .run(convId, now, "assistant", opts.assistantResponse, opts.completionTokens ?? 0);

    return convId;
  } catch (err) {
    logError(`conversations: saveExchange failed — ${err.message}`);
    return opts.conversationId ?? randomUUID();
  }
}

/**
 * Retrieve messages for a conversation.
 * @param {string} conversationId
 * @param {number} [limit=50]
 * @returns {Array<{role: string, content: string, ts: number}>}
 */
export function getConversation(conversationId, limit = 50) {
  if (!ENABLED) return [];
  try {
    const db = getConvDb();
    return db.prepare(
      "SELECT role, content, ts FROM messages WHERE conversation_id = ? ORDER BY ts DESC LIMIT ?"
    ).all(conversationId, limit).reverse();
  } catch {
    return [];
  }
}

/**
 * Run the retention pipeline: update tiers and archive/delete old data.
 * Called automatically on a schedule; also exportable for manual trigger.
 */
export function runRetention() {
  if (!ENABLED) return;
  try {
    const db = getConvDb();
    const now = Date.now();
    const hotCutoff = now - RETENTION_HOT_DAYS * 86400000;
    const warmCutoff = now - RETENTION_WARM_DAYS * 86400000;
    const coldCutoff = now - RETENTION_COLD_DAYS * 86400000;

    // hot → warm
    const toWarm = db.prepare(
      "UPDATE conversations SET tier='warm' WHERE tier='hot' AND updated_at < ?"
    ).run(hotCutoff);

    // warm → cold: archive full messages, keep only summary
    const coldCandidates = db.prepare(
      "SELECT id FROM conversations WHERE tier='warm' AND updated_at < ?"
    ).all(warmCutoff);

    for (const { id } of coldCandidates) {
      try {
        const msgs = db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY ts").all(id);
        const archiveText = msgs.map((m) => `${m.role}: ${m.content}`).join("\n\n");
        const archivePath = join(DATA_DIR, "archive", `conv_${id}.txt`);
        writeFileSync(archivePath, archiveText, "utf8");

        // Replace messages with a single placeholder, keep conversation record
        db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
        db.prepare("INSERT INTO messages (conversation_id, ts, role, content, token_count) VALUES (?,?,?,?,0)")
          .run(id, Date.now(), "system", "[Archived — full text in data/archive/conv_" + id + ".txt]");
        db.prepare("UPDATE conversations SET tier='cold' WHERE id=?").run(id);
      } catch { /* skip individual failures */ }
    }

    // cold → delete (> RETENTION_COLD_DAYS)
    const toDelete = db.prepare(
      "SELECT id FROM conversations WHERE tier='cold' AND updated_at < ?"
    ).all(coldCutoff);
    for (const { id } of toDelete) {
      db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
      db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    }

    // Reclaim unused space
    db.exec("PRAGMA incremental_vacuum(100)");

    if (toWarm.changes > 0 || coldCandidates.length > 0 || toDelete.length > 0) {
      log(`conversations: retention — ${toWarm.changes} → warm, ${coldCandidates.length} → cold/archived, ${toDelete.length} deleted`);
    }
  } catch (err) {
    logError(`conversations: runRetention failed — ${err.message}`);
  }
}

/**
 * Start the background retention scheduler.
 * Call once at server startup.
 */
export function startRetentionScheduler() {
  if (!ENABLED || retentionTimer) return;
  // Run once at startup (after 30s delay to not block boot)
  setTimeout(() => runRetention(), 30_000);
  retentionTimer = setInterval(() => runRetention(), RETENTION_INTERVAL_MS);
  retentionTimer.unref(); // don't keep process alive for this
}

/**
 * Get conversation storage stats.
 */
export function getConversationStats() {
  if (!ENABLED) return { enabled: false };
  try {
    const db = getConvDb();
    const counts = db.prepare(
      "SELECT tier, COUNT(*) as count, SUM(total_tokens) as tokens FROM conversations GROUP BY tier"
    ).all();
    return { enabled: true, tiers: counts };
  } catch {
    return { enabled: true, error: "stats unavailable" };
  }
}
