/**
 * lib/quality-score.js
 * Lightweight heuristic scoring of a provider's response, used to decide
 * whether to accept a 200 OK response or treat it as a soft-failure and
 * try the next provider/model instead.
 *
 * This is intentionally cheap (no extra API calls) — just pattern checks.
 */

const REFUSAL_PATTERNS = [
  /^i (cannot|can't|won't) (help|assist|do that)/i,
  /^i'?m (not able|unable) to/i,
  /^as an ai( language model)?,? i/i,
  /^sorry,? (but )?i (cannot|can't)/i,
  /i (cannot|can't) (fulfill|complete) (this|that) request/i,
];

const MIN_REASONABLE_LENGTH = 2; // characters — catches empty/near-empty strings

/**
 * Score a response's quality using simple heuristics.
 * @param {string} text
 * @param {number} requestedMaxTokens
 * @returns {{ passed: boolean, reasons: string[] }}
 */
export function scoreResponseQuality(text, requestedMaxTokens) {
  const reasons = [];

  if (typeof text !== "string" || text.trim().length < MIN_REASONABLE_LENGTH) {
    reasons.push("response is empty or near-empty");
  }

  const trimmed = (text ?? "").trim();
  if (REFUSAL_PATTERNS.some((re) => re.test(trimmed))) {
    reasons.push("response looks like a boilerplate refusal/error message");
  }

  // Suspiciously short relative to what was asked for (only flag when the
  // caller asked for a substantial generation and got almost nothing back).
  if (requestedMaxTokens >= 256 && trimmed.length > 0 && trimmed.length < 15) {
    reasons.push("response is much shorter than expected for the requested max_tokens");
  }

  return { passed: reasons.length === 0, reasons };
}
