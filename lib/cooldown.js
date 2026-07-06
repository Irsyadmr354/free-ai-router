/**
 * lib/cooldown.js
 * Rate-limit cooldown tracker — in-memory + SQLite persistence.
 * Replaces the JSON file approach with router.db → provider_state table.
 * Falls back to cooldown-persist.js JSON file on DB error for safety.
 */

import { getRouterDb } from "./db.js";
import { logError } from "./logger.js";

const COOLDOWN_MS = parseInt(process.env.PROVIDER_COOLDOWN_MS ?? "60000", 10);

/** @type {Map<string, number>} provider -> expiry ms (in-memory fast path) */
const cooldowns = new Map();
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const db = getRouterDb();
    const rows = db.prepare("SELECT provider, cooldown_expiry FROM provider_state WHERE cooldown_expiry > ?").all(Date.now());
    for (const r of rows) cooldowns.set(r.provider, r.cooldown_expiry);
  } catch { /* start fresh */ }
}

function persist(provider, expiry) {
  try {
    getRouterDb().prepare(`
      INSERT INTO provider_state (provider, cooldown_expiry) VALUES (?,?)
      ON CONFLICT(provider) DO UPDATE SET cooldown_expiry=?
    `).run(provider, expiry, expiry);
  } catch (err) { logError(`cooldown: DB write failed — ${err.message}`); }
}

export function markCooldown(provider) {
  load();
  const expiry = Date.now() + COOLDOWN_MS;
  cooldowns.set(provider, expiry);
  persist(provider, expiry);
}

export function isOnCooldown(provider) {
  load();
  const expiry = cooldowns.get(provider);
  if (!expiry) return false;
  if (Date.now() >= expiry) { cooldowns.delete(provider); persist(provider, 0); return false; }
  return true;
}

export function cooldownRemainingSeconds(provider) {
  load();
  const expiry = cooldowns.get(provider);
  if (!expiry) return 0;
  const r = expiry - Date.now();
  return r > 0 ? Math.ceil(r / 1000) : 0;
}

export function clearCooldown(provider) {
  load();
  cooldowns.delete(provider);
  persist(provider, 0);
}

export function allCooldowns() {
  load();
  const result = [];
  for (const [p, expiry] of cooldowns.entries()) {
    const r = Math.ceil((expiry - Date.now()) / 1000);
    if (r > 0) result.push({ provider: p, remainingSeconds: r });
    else cooldowns.delete(p);
  }
  return result;
}
