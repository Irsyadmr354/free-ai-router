/**
 * lib/logger.js
 * Stderr-only logging helper.
 * All output goes to stderr so stdout remains clean for MCP stdio protocol messages.
 */

const PREFIX = "[free-ai-router]";

/**
 * Log an informational message to stderr.
 * @param {string} message
 */
export function log(message) {
  console.error(`${PREFIX} ${message}`);
}

/**
 * Log an error or warning message to stderr.
 * @param {string} message
 */
export function logError(message) {
  console.error(`${PREFIX} ERROR: ${message}`);
}
