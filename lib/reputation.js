/**
 * lib/reputation.js
 * Provider reputation system — in-memory + SQLite persistence.
 * Replaces pure in-memory Map with router.db → provider_state table.
 */

import { getRouterDb } from "./db.js";
import { getBenchmark } from "./benchmark.js";
import { logError } from "./logger.js";

const NEUTRAL = 70;
const MIN = 0;
const MAX = 100;

/** @type {Map<string, { score: number, last429At: number|null, lastUpdated: number }>} */
const mem = new Map();
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const rows = getRouterDb().prepare("SELECT provider, reputation_score, last_429_at, reputation_updated_at FROM provider_state").all();
    for (const r of rows) {
      mem.set(r.provider, { score: r.reputation_score ?? NEUTRAL, last429At: r.last_429_at, lastUpdated: r.reputation_updated_at ?? Date.now() });
    }
  } catch { /* start fresh */ }
}

function persist(provider, score, last429At) {
  try {
    getRouterDb().prepare(`
      INSERT INTO provider_state (provider, reputation_score, last_429_at, reputation_updated_at) VALUES (?,?,?,?)
      ON CONFLICT(provider) DO UPDATE SET reputation_score=?, last_429_at=?, reputation_updated_at=?
    `).run(provider, score, last429At, Date.now(), score, last429At, Date.now());
  } catch (err) { logError(`reputation: DB write failed — ${err.message}`); }
}

function getEntry(provider) {
  load();
  if (!mem.has(provider)) mem.set(provider, { score: NEUTRAL, last429At: null, lastUpdated: Date.now() });
  return mem.get(provider);
}

export function updateReputation(provider, { success, latencyMs, status = null }) {
  const e = getEntry(provider);
  if (status === 429) { e.last429At = Date.now(); e.score = Math.max(MIN, e.score - 15); }
  else if (!success) { e.score = Math.max(MIN, e.score - 8); }
  else {
    let d = 3;
    if (latencyMs < 2000) d += 2;
    else if (latencyMs > 8000) d -= 2;
    e.score = Math.min(MAX, e.score + d);
  }
  e.lastUpdated = Date.now();
  persist(provider, e.score, e.last429At);
}

export function getReputationScore(provider) {
  const e = getEntry(provider);
  const hours = (Date.now() - e.lastUpdated) / 3_600_000;
  if (hours < 1) return Math.round(e.score);
  const decay = Math.min(hours, Math.abs(e.score - NEUTRAL));
  return Math.round(e.score > NEUTRAL ? e.score - decay : e.score + decay);
}

export function sortByReputation(order) {
  return [...order].map((p, i) => ({ p, i, s: getReputationScore(p) }))
    .sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.p);
}

export function getReputationSnapshot(providers) {
  return providers.map((p) => ({ provider: p, reputation: getReputationScore(p), benchmark: getBenchmark(p) }));
}
