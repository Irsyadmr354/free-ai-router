/**
 * lib/semantic-cache.js
 * Semantic similarity cache using Gemini text-embedding-004.
 *
 * Complements the exact-match cache (lib/cache.js) by catching prompts
 * that are semantically equivalent but not textually identical.
 *
 * How it works:
 *   1. On a cache miss from exact-match cache, generate an embedding for the prompt
 *   2. Compare cosine similarity against stored embeddings in SQLite
 *   3. If similarity >= SEMANTIC_CACHE_THRESHOLD, return the cached response
 *      with a note that it's a semantic (approximate) match
 *   4. On cache write, store embedding alongside the response
 *
 * Storage: router.db → semantic_cache table (separate from response_cache)
 * Embeddings: float32 stored as JSON array — ~3KB per entry at 768 dims
 *
 * Config:
 *   SEMANTIC_CACHE_ENABLED=true
 *   SEMANTIC_CACHE_THRESHOLD=0.95   (cosine similarity, 0-1)
 *   SEMANTIC_CACHE_MAX_ENTRIES=500
 *   SEMANTIC_CACHE_TTL_MS=3600000   (1 hour default — longer than exact cache)
 */

import { getRouterDb } from "./db.js";
import { log, logError } from "./logger.js";

const ENABLED = process.env.SEMANTIC_CACHE_ENABLED === "true";
const THRESHOLD = parseFloat(process.env.SEMANTIC_CACHE_THRESHOLD ?? "0.95");
const MAX_ENTRIES = parseInt(process.env.SEMANTIC_CACHE_MAX_ENTRIES ?? "500", 10);
const TTL_MS = parseInt(process.env.SEMANTIC_CACHE_TTL_MS ?? "3600000", 10);

let _schemaInit = false;

function ensureSchema() {
  if (_schemaInit) return;
  _schemaInit = true;
  try {
    getRouterDb().exec(`
      CREATE TABLE IF NOT EXISTS semantic_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt_hash TEXT NOT NULL,
        prompt_preview TEXT,
        embedding_json TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        hits INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sem_expires ON semantic_cache(expires_at);
    `);
  } catch (err) {
    logError(`semantic-cache: schema init failed — ${err.message}`);
  }
}

/**
 * Compute cosine similarity between two equal-length vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} -1 to 1
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Find a semantically similar cached response.
 * Returns null if semantic cache is disabled, no match found, or on error.
 * @param {number[]} queryEmbedding
 * @returns {{ response: any, similarity: number }|null}
 */
export function semanticCacheGet(queryEmbedding) {
  if (!ENABLED || !queryEmbedding?.length) return null;
  ensureSchema();
  try {
    const db = getRouterDb();
    const now = Date.now();
    const rows = db.prepare(
      "SELECT id, embedding_json, response_json FROM semantic_cache WHERE expires_at > ? LIMIT ?"
    ).all(now, MAX_ENTRIES);

    let best = null;
    let bestSim = -1;
    for (const row of rows) {
      const emb = JSON.parse(row.embedding_json);
      const sim = cosineSimilarity(queryEmbedding, emb);
      if (sim > bestSim) { bestSim = sim; best = row; }
    }

    if (best && bestSim >= THRESHOLD) {
      db.prepare("UPDATE semantic_cache SET hits = hits + 1 WHERE id = ?").run(best.id);
      return { response: JSON.parse(best.response_json), similarity: bestSim };
    }
    return null;
  } catch (err) {
    logError(`semantic-cache: get failed — ${err.message}`);
    return null;
  }
}

/**
 * Store a response with its embedding in the semantic cache.
 * Evicts oldest entry if over MAX_ENTRIES.
 * @param {number[]} embedding
 * @param {string} promptPreview
 * @param {any} response
 */
export function semanticCacheSet(embedding, promptPreview, response) {
  if (!ENABLED || !embedding?.length) return;
  ensureSchema();
  try {
    const db = getRouterDb();
    const now = Date.now();

    // Evict if over capacity
    const count = db.prepare("SELECT COUNT(*) as c FROM semantic_cache").get().c;
    if (count >= MAX_ENTRIES) {
      db.prepare(
        "DELETE FROM semantic_cache WHERE id = (SELECT id FROM semantic_cache ORDER BY hits ASC, created_at ASC LIMIT 1)"
      ).run();
    }

    db.prepare(`
      INSERT INTO semantic_cache (prompt_hash, prompt_preview, embedding_json, response_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      promptPreview.slice(0, 32),
      promptPreview.slice(0, 200),
      JSON.stringify(embedding),
      JSON.stringify(response),
      now,
      now + TTL_MS
    );
  } catch (err) {
    logError(`semantic-cache: set failed — ${err.message}`);
  }
}

/**
 * Return semantic cache stats.
 */
export function semanticCacheStats() {
  if (!ENABLED) return { enabled: false };
  ensureSchema();
  try {
    const db = getRouterDb();
    const row = db.prepare(
      "SELECT COUNT(*) as size, SUM(hits) as total_hits FROM semantic_cache WHERE expires_at > ?"
    ).get(Date.now());
    return {
      enabled: true,
      size: row?.size ?? 0,
      totalHits: row?.total_hits ?? 0,
      threshold: THRESHOLD,
      ttlSeconds: TTL_MS / 1000,
    };
  } catch {
    return { enabled: true, error: "stats unavailable" };
  }
}

export { ENABLED as SEMANTIC_CACHE_ENABLED };
