/**
 * lib/cooldown-persist.js
 * Persists cooldown state to a JSON file so rate-limit cooldowns
 * survive server restarts.
 *
 * File: COOLDOWN_STATE_PATH env var, default ./cooldown-state.json
 * This file is gitignored.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

const STATE_PATH = resolve(process.env.COOLDOWN_STATE_PATH ?? "./cooldown-state.json");

/**
 * Load persisted cooldown entries into the in-memory map.
 * Expired entries are silently dropped.
 * @param {Map<string, number>} cooldownMap  — the live map from cooldown.js
 */
export function loadCooldownState(cooldownMap) {
  if (!existsSync(STATE_PATH)) return;
  try {
    const raw = readFileSync(STATE_PATH, "utf8");
    const data = JSON.parse(raw);
    const now = Date.now();
    for (const [provider, expiry] of Object.entries(data)) {
      if (typeof expiry === "number" && expiry > now) {
        cooldownMap.set(provider, expiry);
      }
    }
  } catch {
    // Corrupt or missing file — start fresh, non-fatal
  }
}

/**
 * Persist the current cooldown map to disk.
 * @param {Map<string, number>} cooldownMap
 */
export function saveCooldownState(cooldownMap) {
  try {
    const obj = Object.fromEntries(cooldownMap.entries());
    writeFileSync(STATE_PATH, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    // Non-fatal — don't crash the server if we can't write
  }
}
