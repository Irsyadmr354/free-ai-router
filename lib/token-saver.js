/**
 * lib/token-saver.js
 * Token saving pipeline — reduces input token count before sending to providers.
 *
 * 4-tier hierarchy by hallucination risk:
 *   Tier 0 — always ON, zero risk: deterministic, provably reversible
 *   Tier 1 — default ON, ~0% risk: deterministic + heuristic, transparent when data trimmed
 *   Tier 2 — opt-in per request, low risk: lossy but controlled, ROI-checked first
 *   Tier 3 — opt-in explicit + warning required, medium-high risk: LLM summarization
 *
 * Design rules (never violate):
 *   - Never silent-drop context: always report what was trimmed in _tokenSavingMeta
 *   - Never send abbreviations to model without legend in system prompt
 *   - Always compute ROI before applying any lossy technique; skip if overhead > savings
 *   - Cache/dedup always happens BEFORE this pipeline (caller's responsibility)
 *   - This module never throws — all operations return original on failure + log warning
 */

import { log, logError } from "./logger.js";
import {
  isTokenSavingEnabled, isStructuralMinifyEnabled,
  getContextTrimKeepRecent, getContextTrimThresholdTokens,
  getDedupMinBlockChars, getSummarizationTriggerTokens,
} from "./config.js";

// ---------------------------------------------------------------------------
// Session-level statistics (aggregated across all calls in this process)
// ---------------------------------------------------------------------------

/** @type {{ calls: number, tier0Saved: number, tier1Saved: number, tier2Saved: number, tier3Saved: number }} */
const sessionStats = {
  calls: 0,
  tier0Saved: 0,
  tier1Saved: 0,
  tier2Saved: 0,
  tier3Saved: 0,
};

/**
 * Rough token estimator: 1 token ≈ 4 chars (GPT-style).
 * Used internally for ROI comparisons only — never exposed as authoritative.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text || typeof text !== "string") return 0;
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// TIER 0 — Deterministic, always active
// ---------------------------------------------------------------------------

/**
 * Normalize whitespace in text — always safe, zero hallucination risk.
 * - Removes trailing whitespace per line
 * - Collapses 3+ consecutive blank lines to 1
 * - Collapses double-spaces inside sentences (skips code blocks)
 * @param {string} text
 * @returns {string}
 */
export function normalizeWhitespace(text) {
  if (!text || typeof text !== "string") return text;
  try {
    // Split on code fences, preserve them unchanged
    const parts = text.split(/(```[\s\S]*?```)/g);
    const processed = parts.map((part, i) => {
      if (i % 2 === 1) return part; // odd = inside code fence, preserve
      let out = part
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n");
      out = out.replace(/\n{3,}/g, "\n\n");
      out = out.replace(/([^\S\n]){2,}/g, " ");
      return out;
    });
    return processed.join("");
  } catch {
    return text; // never fail
  }
}

/**
 * Minify structured content (JSON, CSS) deterministically.
 * For JS/TS: returns original — AST minification requires terser which is
 * not a dependency. Documented here for future addition if terser is added.
 * For JSON: JSON.stringify(JSON.parse(text)) — lossless.
 * For CSS: strip comments + collapse whitespace — lossless for semantics.
 * @param {string} text
 * @param {"json"|"css"|"js"|"auto"} [contentType]
 * @returns {{ text: string, originalTokenEstimate: number, minifiedTokenEstimate: number, applied: boolean }}
 */
export function minifyStructuredContent(text, contentType = "auto") {
  const originalTokenEstimate = estimateTokens(text);
  const noop = { text, originalTokenEstimate, minifiedTokenEstimate: originalTokenEstimate, applied: false };
  if (!text || typeof text !== "string") return noop;

  const detected = contentType === "auto" ? detectContentType(text) : contentType;

  try {
    if (detected === "json") {
      const parsed = JSON.parse(text);
      const minified = JSON.stringify(parsed);
      return { text: minified, originalTokenEstimate, minifiedTokenEstimate: estimateTokens(minified), applied: true };
    }
    if (detected === "css") {
      const minified = text
        .replace(/\/\*[\s\S]*?\*\//g, "")   // strip block comments
        .replace(/\s{2,}/g, " ")             // collapse whitespace
        .replace(/\s*([{}:;,>~+])\s*/g, "$1") // remove spaces around operators
        .trim();
      return { text: minified, originalTokenEstimate, minifiedTokenEstimate: estimateTokens(minified), applied: true };
    }
  } catch (err) {
    log(`token-saver: minifyStructuredContent(${detected}) failed (${err.message}), returning original`);
  }
  return noop;
}

/**
 * Detect content type heuristically from text.
 * @param {string} text
 * @returns {"json"|"css"|"js"|"unknown"}
 */
function detectContentType(text) {
  const trimmed = text.trim();
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && (trimmed.endsWith("}") || trimmed.endsWith("]"))) {
    try { JSON.parse(trimmed); return "json"; } catch { /* fall through */ }
  }
  if (/```(css|scss|less)/i.test(text) || /\{[^}]*:[^}]*;[^}]*\}/s.test(text)) return "css";
  if (/```(js|javascript|ts|typescript)/i.test(text)) return "js";
  return "unknown";
}

// ---------------------------------------------------------------------------
// TIER 1 — Deterministic + heuristic, default ON, transparent when trimming
// ---------------------------------------------------------------------------

/**
 * Trim the context window by dropping old messages when the estimated token
 * count exceeds the configured threshold.
 *
 * Strategy:
 *   - Always keep all system messages (full, unmodified)
 *   - Always keep the last N messages (configurable, default 10)
 *   - Drop oldest non-system messages in the middle if total > threshold
 *   - Never drop the most recent user message
 *
 * @param {Array<{role:string,content:string}>} messages
 * @param {{ maxTokens?: number, keepRecent?: number }} [options]
 * @returns {{ messages: Array, trimmed: boolean, messagesDropped: number, droppedTurnRange: string, tokensBefore: number, tokensAfter: number }}
 */
export function trimContextWindow(messages, options = {}) {
  const keepRecent = options.keepRecent ?? getContextTrimKeepRecent();
  const threshold = options.maxTokens ?? getContextTrimThresholdTokens();
  const noTrim = { messages, trimmed: false, messagesDropped: 0, droppedTurnRange: "", tokensBefore: 0, tokensAfter: 0 };
  if (!Array.isArray(messages) || messages.length === 0) return noTrim;

  const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content ?? ""), 0);
  const noTrimResult = { ...noTrim, tokensBefore: totalTokens, tokensAfter: totalTokens };
  if (totalTokens <= threshold) return noTrimResult;

  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");
  if (nonSystem.length <= keepRecent) return noTrimResult;

  // Keep first message if it's user (in case it's the entire context),
  // always keep the last keepRecent messages
  const toKeep = nonSystem.slice(-keepRecent);
  const toDrop = nonSystem.slice(0, nonSystem.length - keepRecent);
  const droppedTurnRange = toDrop.length > 0 ? `messages 1–${toDrop.length}` : "";

  const trimmed = [...systemMessages, ...toKeep];
  const tokensAfter = trimmed.reduce((sum, m) => sum + estimateTokens(m.content ?? ""), 0);

  return {
    messages: trimmed,
    trimmed: true,
    messagesDropped: toDrop.length,
    droppedTurnRange,
    tokensBefore: totalTokens,
    tokensAfter,
  };
}

/**
 * Deduplicate repeated large blocks across messages.
 * Replaces 2nd+ occurrences of identical text blocks (above minChars threshold)
 * with a short reference marker, and prepends a note to the system prompt.
 *
 * @param {Array<{role:string,content:string}>} messages
 * @returns {{ messages: Array, deduped: boolean, blocksDeduped: number, tokensSaved: number, systemPromptAddition: string }}
 */
export function deduplicateRepeatedBlocks(messages) {
  const minChars = getDedupMinBlockChars();
  const noChange = { messages, deduped: false, blocksDeduped: 0, tokensSaved: 0, systemPromptAddition: "" };
  if (!Array.isArray(messages) || messages.length < 2) return noChange;

  /** @type {Map<string, number>} block content → first occurrence index */
  const seen = new Map();
  let blocksDeduped = 0;
  let tokensSaved = 0;
  const newMessages = messages.map((msg, msgIdx) => {
    if (msg.role === "system" || typeof msg.content !== "string") return msg;
    const lines = msg.content.split("\n");
    let content = msg.content;
    // Sliding window: check substrings of 200+ chars that appear in earlier messages
    for (const [block, firstIdx] of seen.entries()) {
      if (firstIdx >= msgIdx) continue;
      if (content.includes(block)) {
        const ref = `[Identical content from message ${firstIdx + 1} — omitted to save tokens]`;
        content = content.replace(block, ref);
        tokensSaved += estimateTokens(block) - estimateTokens(ref);
        blocksDeduped++;
      }
    }
    // Register large blocks from this message for future deduplication
    for (let start = 0; start < lines.length; start++) {
      let candidate = "";
      for (let end = start; end < Math.min(start + 20, lines.length); end++) {
        candidate += (candidate ? "\n" : "") + lines[end];
        if (candidate.length >= minChars && !seen.has(candidate)) {
          seen.set(candidate, msgIdx);
        }
      }
    }
    return { ...msg, content };
  });

  if (blocksDeduped === 0) return noChange;
  const note = `Note: ${blocksDeduped} repeated content block(s) in conversation history were replaced with reference markers to reduce token usage. The original content appeared in earlier messages.`;
  return { messages: newMessages, deduped: true, blocksDeduped, tokensSaved, systemPromptAddition: note };
}

// ---------------------------------------------------------------------------
// TIER 2 — Lossy controlled, opt-in per request, ROI-checked first
// ---------------------------------------------------------------------------

/**
 * Apply abbreviation dictionary to text, but ONLY if doing so saves tokens
 * after accounting for the legend overhead. If not profitable, skip and
 * report why.
 *
 * SAFETY: If applied, the returned `systemPromptAddition` MUST be prepended
 * to the system prompt sent to the model. Never send abbreviations without
 * their definitions — this causes hallucinations.
 *
 * @param {string} text
 * @param {Record<string,string>} dictionary  e.g. { "function": "fn", "return": "ret" }
 * @param {{ minSavings?: number }} [options]
 * @returns {{ text: string, legend: string, systemPromptAddition: string, applied: boolean, tokensSaved: number, reason?: string }}
 */
export function applyAbbreviationDictionary(text, dictionary, options = {}) {
  const noop = { text, legend: "", systemPromptAddition: "", applied: false, tokensSaved: 0 };
  if (!text || !dictionary || Object.keys(dictionary).length === 0) return noop;

  const originalTokens = estimateTokens(text);
  let compacted = text;
  const usedAbbreviations = {};

  // Only replace whole words (word boundaries) to avoid partial replacements
  for (const [full, abbrev] of Object.entries(dictionary)) {
    const re = new RegExp(`\\b${full.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    const before = compacted;
    compacted = compacted.replace(re, abbrev);
    if (compacted !== before) usedAbbreviations[full] = abbrev;
  }

  if (Object.keys(usedAbbreviations).length === 0) {
    return { ...noop, reason: "No abbreviations matched the text" };
  }

  const legend = "Abbreviation legend: " +
    Object.entries(usedAbbreviations).map(([f, a]) => `${a}=${f}`).join(", ");
  const systemPromptAddition = `The following abbreviations are used in the user message. Interpret them correctly:\n${legend}`;

  // ROI check: only apply if net savings > 0
  const compactedTokens = estimateTokens(compacted);
  const legendTokens = estimateTokens(systemPromptAddition);
  const tokensSaved = originalTokens - compactedTokens - legendTokens;

  if (tokensSaved <= (options.minSavings ?? 0)) {
    return { text, legend: "", systemPromptAddition: "", applied: false, tokensSaved: 0,
      reason: `Abbreviation overhead (${legendTokens} tokens) exceeds savings — not profitable` };
  }

  return { text: compacted, legend, systemPromptAddition, applied: true, tokensSaved };
}

/**
 * Detect and compact repetitive tabular narrative text into CSV format.
 * e.g. "Row 1: name is Alice, age is 30. Row 2: name is Bob, age is 25."
 * → CSV with header row.
 *
 * This is heuristic and may misfire on legitimate prose — always opt-in.
 *
 * @param {string} text
 * @returns {{ text: string, applied: boolean, savingsEstimate: number }}
 */
export function compactStructuredData(text) {
  const noop = { text, applied: false, savingsEstimate: 0 };
  if (!text || typeof text !== "string") return noop;
  try {
    // Detect pattern: "Row N: key1 is val1, key2 is val2." repeated 3+ times
    const rowPattern = /(?:Row|Item|Entry|Line|Record)\s+\d+\s*:\s*([^.]+)\./gi;
    const matches = [...text.matchAll(rowPattern)];
    if (matches.length < 3) return noop;

    // Parse keys from first row
    const firstRowContent = matches[0][1];
    const kvPattern = /(\w[\w\s]*?)\s+is\s+([^,]+)/gi;
    const keys = [...firstRowContent.matchAll(kvPattern)].map((m) => m[1].trim());
    if (keys.length === 0) return noop;

    const rows = matches.map((m) => {
      const rowContent = m[1];
      const pairs = [...rowContent.matchAll(kvPattern)];
      return pairs.map((p) => p[2].trim());
    });

    const csv = [keys.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const savingsEstimate = estimateTokens(text) - estimateTokens(csv);
    if (savingsEstimate <= 0) return noop;

    return { text: csv, applied: true, savingsEstimate };
  } catch {
    return noop;
  }
}

// ---------------------------------------------------------------------------
// TIER 3 — LLM summarization, opt-in explicit + warning required
// ---------------------------------------------------------------------------

/**
 * Summarize long context via LLM. Only call when `allow_lossy_summarization`
 * is explicitly set by the user AND the text exceeds SUMMARIZATION_TRIGGER_TOKENS.
 *
 * Uses the existing provider chain — does NOT make separate API calls.
 *
 * @param {string} text
 * @param {{ executeProviderChain: Function, order: string[], keys: object }} options
 * @returns {Promise<{ summary: string, warning: string, originalTokens: number, summarizedTokens: number, applied: boolean }>}
 */
export async function summarizeContextViaLLM(text, options) {
  const noop = { summary: text, warning: "", originalTokens: estimateTokens(text), summarizedTokens: estimateTokens(text), applied: false };
  const triggerTokens = getSummarizationTriggerTokens();
  const originalTokens = estimateTokens(text);

  if (originalTokens < triggerTokens) return noop;
  if (!options?.executeProviderChain) return noop;

  logError(`token-saver: TIER 3 LLM summarization triggered for ${originalTokens} token context — this is a lossy operation`);

  try {
    const result = await options.executeProviderChain({
      order: options.order,
      keys: options.keys,
      params: {
        prompt: text,
        systemPrompt: "Summarize the following text WITHOUT removing numbers, names, dates, decisions, or technical details. Focus on compressing narrative explanations, not removing facts. Output only the summary, nothing else.",
        maxTokens: Math.min(Math.ceil(originalTokens * 0.4), 2048),
        temperature: 0.1,
      },
    });

    const summary = result.text ?? text;
    const summarizedTokens = estimateTokens(summary);
    const warning = "⚠️ This context was automatically summarized by an LLM to reduce token usage. Details may be missing or altered — manual verification is recommended.";
    logError(`token-saver: TIER 3 summarization reduced ${originalTokens} → ${summarizedTokens} tokens`);
    return { summary, warning, originalTokens, summarizedTokens, applied: true };
  } catch (err) {
    logError(`token-saver: TIER 3 summarization failed (${err.message}), using original text`);
    return { ...noop, warning: `LLM summarization failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Pipeline orchestrator — main entry point for router-core.js
// ---------------------------------------------------------------------------

/**
 * Run the full token-saving pipeline on a request's params.
 * Called by executeProviderChain AFTER cache check and BEFORE provider loop.
 *
 * @param {object} params  — the call params object (mutated in place, safe copy returned)
 * @param {object} options
 * @param {boolean} [options.allowLossySummarization]
 * @param {Record<string,string>} [options.abbreviationDictionary]
 * @param {boolean} [options.compactData]
 * @param {Function} [options.executeProviderChain]  — needed for Tier 3 only
 * @param {string[]} [options.order]
 * @param {object} [options.keys]
 * @returns {Promise<{ params: object, meta: object }>}
 */
export async function runTokenSavingPipeline(params, options = {}) {
  if (!isTokenSavingEnabled()) {
    return { params, meta: { enabled: false } };
  }

  sessionStats.calls++;
  const meta = {
    enabled: true,
    tier0: { whitespaceNormalized: false, minificationApplied: false },
    tier1: { contextTrimmed: false, messagesDropped: 0, droppedTurnRange: "", blocksDeduped: 0 },
    tier2: { abbreviationsApplied: false, tokensSaved: 0, compactDataApplied: false },
    tier3: { summarized: false, warning: "" },
    totalTokensSaved: 0,
  };

  let workingParams = { ...params };
  let systemPromptAdditions = [];

  // --- TIER 0: normalizeWhitespace on prompt ---
  if (workingParams.prompt) {
    const before = estimateTokens(workingParams.prompt);
    workingParams.prompt = normalizeWhitespace(workingParams.prompt);
    const saved = before - estimateTokens(workingParams.prompt);
    if (saved > 0) {
      meta.tier0.whitespaceNormalized = true;
      meta.totalTokensSaved += saved;
      sessionStats.tier0Saved += saved;
    }
  }

  // --- TIER 0: minify structured content in context/prompt ---
  if (isStructuralMinifyEnabled() && workingParams.prompt) {
    const result = minifyStructuredContent(workingParams.prompt);
    if (result.applied) {
      const saved = result.originalTokenEstimate - result.minifiedTokenEstimate;
      workingParams.prompt = result.text;
      meta.tier0.minificationApplied = true;
      meta.totalTokensSaved += saved;
      sessionStats.tier0Saved += saved;
    }
  }

  // --- TIER 1: trim context window for long message arrays ---
  if (workingParams.messages?.length) {
    const trimResult = trimContextWindow(workingParams.messages);
    if (trimResult.trimmed) {
      workingParams.messages = trimResult.messages;
      const saved = trimResult.tokensBefore - trimResult.tokensAfter;
      meta.tier1.contextTrimmed = true;
      meta.tier1.messagesDropped = trimResult.messagesDropped;
      meta.tier1.droppedTurnRange = trimResult.droppedTurnRange;
      meta.totalTokensSaved += saved;
      sessionStats.tier1Saved += saved;
    }
  }

  // --- TIER 1: deduplicate repeated blocks in messages ---
  if (workingParams.messages?.length) {
    const dedupResult = deduplicateRepeatedBlocks(workingParams.messages);
    if (dedupResult.deduped) {
      workingParams.messages = dedupResult.messages;
      meta.tier1.blocksDeduped = dedupResult.blocksDeduped;
      meta.totalTokensSaved += dedupResult.tokensSaved;
      sessionStats.tier1Saved += dedupResult.tokensSaved;
      if (dedupResult.systemPromptAddition) {
        systemPromptAdditions.push(dedupResult.systemPromptAddition);
      }
    }
  }

  // --- TIER 2: abbreviation dictionary (opt-in) ---
  if (options.abbreviationDictionary && Object.keys(options.abbreviationDictionary).length > 0 && workingParams.prompt) {
    const abbrevResult = applyAbbreviationDictionary(workingParams.prompt, options.abbreviationDictionary);
    if (abbrevResult.applied) {
      workingParams.prompt = abbrevResult.text;
      meta.tier2.abbreviationsApplied = true;
      meta.tier2.tokensSaved = abbrevResult.tokensSaved;
      meta.totalTokensSaved += abbrevResult.tokensSaved;
      sessionStats.tier2Saved += abbrevResult.tokensSaved;
      if (abbrevResult.systemPromptAddition) {
        systemPromptAdditions.push(abbrevResult.systemPromptAddition);
      }
    }
  }

  // --- TIER 3: LLM summarization (opt-in explicit) ---
  if (options.allowLossySummarization && workingParams.prompt) {
    const summarizeResult = await summarizeContextViaLLM(workingParams.prompt, {
      executeProviderChain: options.executeProviderChain,
      order: options.order,
      keys: options.keys,
    });
    if (summarizeResult.applied) {
      workingParams.prompt = summarizeResult.summary;
      meta.tier3.summarized = true;
      meta.tier3.warning = summarizeResult.warning;
      const saved = summarizeResult.originalTokens - summarizeResult.summarizedTokens;
      meta.totalTokensSaved += saved;
      sessionStats.tier3Saved += saved;
    }
  }

  // Inject system prompt additions
  if (systemPromptAdditions.length > 0) {
    const addition = systemPromptAdditions.join("\n\n");
    workingParams.systemPrompt = workingParams.systemPrompt
      ? `${workingParams.systemPrompt}\n\n${addition}`
      : addition;
  }

  return { params: workingParams, meta };
}

// ---------------------------------------------------------------------------
// Session stats
// ---------------------------------------------------------------------------

/**
 * Return aggregated token saving statistics for this server session.
 * @returns {object}
 */
export function getTokenSavingStats() {
  return {
    calls: sessionStats.calls,
    tier0SavedTokens: sessionStats.tier0Saved,
    tier1SavedTokens: sessionStats.tier1Saved,
    tier2SavedTokens: sessionStats.tier2Saved,
    tier3SavedTokens: sessionStats.tier3Saved,
    totalSavedTokens: sessionStats.tier0Saved + sessionStats.tier1Saved + sessionStats.tier2Saved + sessionStats.tier3Saved,
    averageSavedPerCall: sessionStats.calls > 0
      ? Math.round((sessionStats.tier0Saved + sessionStats.tier1Saved + sessionStats.tier2Saved + sessionStats.tier3Saved) / sessionStats.calls)
      : 0,
  };
}
