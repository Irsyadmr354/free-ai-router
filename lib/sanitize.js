/**
 * lib/sanitize.js
 * Input sanitization for prompts before they're sent to any provider.
 *   - Strips null bytes
 * 	 - Truncates to a configured max length
 *   - Optionally redacts substrings that look like API keys, so a pasted
 *     secret doesn't get forwarded to a third-party provider verbatim.
 */

import { getSanitizationConfig } from "./config.js";

// Conservative patterns for common API key shapes. This is best-effort
// redaction, not a security boundary — it only catches obviously-shaped keys.
const KEY_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/g,            // OpenAI-style
  /AIza[0-9A-Za-z\-_]{20,}/g,        // Google API keys
  /gsk_[A-Za-z0-9]{20,}/g,           // Groq
  /r8_[A-Za-z0-9]{20,}/g,            // Replicate
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,   // Slack
  /ghp_[A-Za-z0-9]{30,}/g,           // GitHub PAT
  /AKIA[0-9A-Z]{16}/g,               // AWS access key id
];

/**
 * Sanitize a prompt string: strip null bytes, clamp length, redact keys.
 * @param {string} text
 * @returns {{ text: string, truncated: boolean, redactions: number }}
 */
export function sanitizePrompt(text) {
  if (typeof text !== "string") return { text, truncated: false, redactions: 0 };

  const { maxPromptChars, redactApiKeys } = getSanitizationConfig();

  let out = text.replace(/\u0000/g, "");

  let redactions = 0;
  if (redactApiKeys) {
    for (const pattern of KEY_PATTERNS) {
      out = out.replace(pattern, () => {
        redactions += 1;
        return "[REDACTED_API_KEY]";
      });
    }
  }

  let truncated = false;
  if (out.length > maxPromptChars) {
    out = out.slice(0, maxPromptChars);
    truncated = true;
  }

  return { text: out, truncated, redactions };
}
