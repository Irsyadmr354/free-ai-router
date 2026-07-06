/**
 * lib/config.js
 * Centralised runtime configuration.
 *
 * PROVIDER_ORDER env var controls fallback sequence.
 * Default: gemini,groq,openrouter,cloudflare,together,cohere,mistral
 *
 * Per-provider timeouts (ms) can be set via:
 *   TIMEOUT_GEMINI_MS, TIMEOUT_GROQ_MS, TIMEOUT_OPENROUTER_MS,
 *   TIMEOUT_CLOUDFLARE_MS, TIMEOUT_TOGETHER_MS, TIMEOUT_COHERE_MS,
 *   TIMEOUT_MISTRAL_MS
 * Default timeout for all: 15000 ms.
 */

const ALL_PROVIDERS = [
  "gemini",
  "groq",
  "openrouter",
  "cloudflare",
  "sambanova",
  "cohere",
  "mistral",
];

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Returns the ordered list of provider names to try, derived from
 * the PROVIDER_ORDER env var or the built-in default.
 * Unknown provider names are silently filtered out.
 * @returns {string[]}
 */
export function getProviderOrder() {
  const raw = process.env.PROVIDER_ORDER;
  if (!raw) return [...ALL_PROVIDERS];
  return raw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => ALL_PROVIDERS.includes(p));
}

/**
 * Returns the timeout in ms for a given provider.
 * @param {string} provider
 * @returns {number}
 */
export function getTimeout(provider) {
  const envKey = `TIMEOUT_${provider.toUpperCase()}_MS`;
  const val = parseInt(process.env[envKey] ?? "", 10);
  return isNaN(val) ? DEFAULT_TIMEOUT_MS : val;
}

/**
 * Returns all provider API keys from the environment.
 * @returns {Record<string, string|undefined>}
 */
export function getApiKeys() {
  return {
    gemini: process.env.GEMINI_API_KEY,
    groq: process.env.GROQ_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
    cloudflare: process.env.CLOUDFLARE_API_TOKEN,
    sambanova: process.env.SAMBANOVA_API_KEY,
    cohere: process.env.COHERE_API_KEY,
    mistral: process.env.MISTRAL_API_KEY,
  };
}

export { ALL_PROVIDERS };
