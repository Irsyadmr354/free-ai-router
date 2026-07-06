/**
 * lib/prompt-analyzer.js
 * Prompt complexity analyzer for intelligent provider routing.
 *
 * Analyzes a prompt to determine its complexity profile, which informs
 * which provider/model is most likely to give a good response.
 *
 * Complexity dimensions scored 0-1:
 *   - length:       token count relative to providers' context limits
 *   - code:         presence and density of code blocks / technical syntax
 *   - reasoning:    presence of logical, mathematical, or multi-step reasoning
 *   - creativity:   creative writing, brainstorming, open-ended tasks
 *   - factual:      factual questions, research, accuracy-critical tasks
 *   - multilingual: non-English content detection
 *
 * Provider affinity scores (hardcoded heuristics, updated as models evolve):
 *   gemini:      strong reasoning, long context, multimodal
 *   groq:        fastest, good for simple/chat/code
 *   openrouter:  versatile, depends on routed model
 *   cloudflare:  simple/fast tasks, short context
 *   cohere:      RAG, search, enterprise factual
 *   mistral:     code + reasoning, good multilingual
 *   opencode-zen: coding agents
 */

import { estimateTokens } from "./token-saver.js";

/**
 * @typedef {object} PromptProfile
 * @property {number} length       0-1, normalized token count
 * @property {number} code         0-1, code density
 * @property {number} reasoning    0-1, reasoning complexity
 * @property {number} creativity   0-1, creative task signal
 * @property {number} factual      0-1, factual/research signal
 * @property {number} multilingual 0-1, non-English signal
 * @property {string} dominantType the highest-scoring dimension
 * @property {number} totalComplexity 0-1, weighted overall
 */

/**
 * Analyze a prompt and return a complexity profile.
 * Fast heuristic — no external calls.
 * @param {string} prompt
 * @param {string} [systemPrompt]
 * @returns {PromptProfile}
 */
export function analyzePrompt(prompt, systemPrompt = "") {
  const combined = [systemPrompt, prompt].filter(Boolean).join("\n");
  const tokens = estimateTokens(combined);

  // --- Length score ---
  const length = Math.min(tokens / 8000, 1);

  // --- Code score ---
  const codeBlocks = (combined.match(/```[\s\S]*?```/g) ?? []).length;
  const codeLines = (combined.match(/^\s*(function|const|let|var|def |class |import |export |#include|package |public |private )/gm) ?? []).length;
  const code = Math.min((codeBlocks * 0.3 + codeLines * 0.05), 1);

  // --- Reasoning score ---
  const reasoningKeywords = /\b(prove|derive|calculate|analyze|compare|explain why|step.by.step|reason|logic|therefore|because|if.*then|math|equation|algorithm|complexity|optimize)\b/gi;
  const reasoningMatches = (combined.match(reasoningKeywords) ?? []).length;
  const reasoning = Math.min(reasoningMatches * 0.1, 1);

  // --- Creativity score ---
  const creativeKeywords = /\b(write|story|poem|creative|imagine|brainstorm|generate ideas|describe|narrative|fiction|essay|suggest|invent)\b/gi;
  const creativeMatches = (combined.match(creativeKeywords) ?? []).length;
  const creativity = Math.min(creativeMatches * 0.15, 1);

  // --- Factual score ---
  const factualKeywords = /\b(what is|who is|when did|where is|how many|define|fact|history|according to|research|source|cite|reference|accurate)\b/gi;
  const factualMatches = (combined.match(factualKeywords) ?? []).length;
  const factual = Math.min(factualMatches * 0.12, 1);

  // --- Multilingual score ---
  // Detect non-ASCII characters that suggest non-English text
  const nonAsciiRatio = (combined.match(/[^\x00-\x7F]/g) ?? []).length / Math.max(combined.length, 1);
  const multilingual = Math.min(nonAsciiRatio * 5, 1);

  // --- Dominant type ---
  const dimensions = { length, code, reasoning, creativity, factual, multilingual };
  const dominantType = Object.entries(dimensions)
    .filter(([k]) => k !== "length") // length is a modifier, not a type
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? "chat";

  // --- Total complexity (weighted) ---
  const totalComplexity = Math.min(
    code * 0.25 + reasoning * 0.30 + length * 0.20 +
    creativity * 0.10 + factual * 0.10 + multilingual * 0.05,
    1
  );

  return { length, code, reasoning, creativity, factual, multilingual, dominantType, totalComplexity };
}

/**
 * Score provider affinity for a given prompt profile.
 * Returns sorted list of providers from most to least suitable.
 * @param {PromptProfile} profile
 * @param {string[]} availableProviders
 * @returns {string[]} providers sorted by affinity (descending)
 */
export function rankProvidersByAffinity(profile, availableProviders) {
  const AFFINITY = {
    gemini:          { code: 0.7, reasoning: 0.9, creativity: 0.8, factual: 0.8, multilingual: 0.6, longContext: 0.9 },
    groq:            { code: 0.8, reasoning: 0.6, creativity: 0.5, factual: 0.5, multilingual: 0.4, longContext: 0.4 },
    openrouter:      { code: 0.7, reasoning: 0.7, creativity: 0.7, factual: 0.7, multilingual: 0.6, longContext: 0.6 },
    cloudflare:      { code: 0.5, reasoning: 0.4, creativity: 0.4, factual: 0.4, multilingual: 0.3, longContext: 0.2 },
    cohere:          { code: 0.4, reasoning: 0.5, creativity: 0.4, factual: 0.9, multilingual: 0.5, longContext: 0.7 },
    mistral:         { code: 0.8, reasoning: 0.7, creativity: 0.6, factual: 0.6, multilingual: 0.8, longContext: 0.5 },
    "opencode-zen":  { code: 0.9, reasoning: 0.7, creativity: 0.4, factual: 0.5, multilingual: 0.4, longContext: 0.6 },
  };

  const score = (provider) => {
    const a = AFFINITY[provider];
    if (!a) return 0.5; // unknown provider — neutral
    return (
      profile.code * a.code +
      profile.reasoning * a.reasoning +
      profile.creativity * a.creativity +
      profile.factual * a.factual +
      profile.multilingual * a.multilingual +
      profile.length * a.longContext
    ) / 6;
  };

  return [...availableProviders].sort((a, b) => score(b) - score(a));
}

/**
 * Combined: analyze + rank in one call.
 * Only reorders if PROMPT_ANALYSIS_ROUTING=true.
 * @param {string} prompt
 * @param {string} systemPrompt
 * @param {string[]} order
 * @returns {{ order: string[], profile: PromptProfile }}
 */
export function analyzeAndRoute(prompt, systemPrompt, order) {
  const profile = analyzePrompt(prompt, systemPrompt);
  if (process.env.PROMPT_ANALYSIS_ROUTING !== "true") {
    return { order, profile };
  }
  // Only reorder if complexity is meaningful (>0.2) to avoid thrashing on simple prompts
  if (profile.totalComplexity < 0.2) return { order, profile };
  const reordered = rankProvidersByAffinity(profile, order);
  return { order: reordered, profile };
}
