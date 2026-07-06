/**
 * lib/config.js
 * Centralised runtime configuration.
 *
 * PROVIDER_ORDER env var controls fallback sequence.
 * Default: gemini,groq,openrouter,cloudflare,sambanova,cohere,mistral
 *
 * Per-provider timeouts (ms) can be set via:
 *   TIMEOUT_GEMINI_MS, TIMEOUT_GROQ_MS, TIMEOUT_OPENROUTER_MS,
 *   TIMEOUT_CLOUDFLARE_MS, TIMEOUT_SAMBANOVA_MS, TIMEOUT_COHERE_MS,
 *   TIMEOUT_MISTRAL_MS
 * Default timeout for all: 15000 ms.
 *
 * MODEL_FALLBACK_ENABLED (default: true) — when a provider's chosen model
 * fails with a retryable error, try the next model in that provider's
 * SUPPORTED_MODELS list before moving on to the next provider.
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
 * Returns whether in-provider model fallback is enabled.
 * When enabled, if a model fails with a retryable error (5xx, network/timeout,
 * or "response missing expected text field"), the router tries the next
 * model in that provider's SUPPORTED_MODELS list before moving to the next
 * provider entirely. Does NOT retry on 401/403 (auth) — only on errors where
 * a different model plausibly fixes things. 429 is still handled by cooldown
 * at the provider level, not by switching models.
 * Default: true. Disable via MODEL_FALLBACK_ENABLED=false.
 * @returns {boolean}
 */
export function isModelFallbackEnabled() {
  return process.env.MODEL_FALLBACK_ENABLED !== "false";
}

const DEFAULT_MAX_TOKENS_CAP = {
  gemini: 8192,
  groq: 8192,
  openrouter: 4096,
  cloudflare: 4096,
  sambanova: 8192,
  cohere: 4096,
  mistral: 8192,
};

export function getMaxTokensCap(provider) {
  const envKey = `MAX_TOKENS_CAP_${provider.toUpperCase()}`;
  const val = parseInt(process.env[envKey] ?? "", 10);
  if (!isNaN(val) && val > 0) return val;
  return DEFAULT_MAX_TOKENS_CAP[provider] ?? 4096;
}

const DEFAULT_BUDGETS = {
  gemini:     { limit: 1500,  window: "day" },
  groq:       { limit: 14400, window: "day" },
  openrouter: { limit: null,  window: "day" },
  cloudflare: { limit: 10000, window: "day" },
  sambanova:  { limit: 48000, window: "day" },
  cohere:     { limit: 1000,  window: "month" },
  mistral:    { limit: null,  window: "day" },
};

export function getBudget(provider) {
  const envKey = `BUDGET_${provider.toUpperCase()}`;
  const raw = process.env[envKey];
  if (raw !== undefined) {
    const val = parseInt(raw, 10);
    if (!isNaN(val) && val > 0) {
      return { limit: val, window: DEFAULT_BUDGETS[provider]?.window ?? "day" };
    }
  }
  return DEFAULT_BUDGETS[provider] ?? { limit: null, window: "day" };
}

export function getBudgetDeprioritizeThreshold() {
  const val = parseFloat(process.env.BUDGET_DEPRIORITIZE_THRESHOLD ?? "0.9");
  return isNaN(val) ? 0.9 : val;
}

export function getProviderAliases() {
  const aliases = {};
  for (const [key, value] of Object.entries(process.env)) {
    const match = /^ALIAS_(.+)$/.exec(key);
    if (match && value) {
      aliases[match[1].toLowerCase()] = value.trim().toLowerCase();
    }
  }
  return aliases;
}

export function resolveProviderAliases(names) {
  const aliases = getProviderAliases();
  return names.map((n) => aliases[n.toLowerCase()] ?? n);
}

export function getSanitizationConfig() {
  const maxPromptChars = parseInt(process.env.MAX_PROMPT_CHARS ?? "32000", 10);
  return {
    maxPromptChars: isNaN(maxPromptChars) ? 32000 : maxPromptChars,
    redactApiKeys: process.env.REDACT_API_KEYS_IN_PROMPT !== "false",
  };
}

export function isQualityScoringEnabled() {
  return process.env.QUALITY_SCORING_ENABLED === "true";
}

export function isMultiLanguagePromptEnabled() {
  return process.env.MULTI_LANGUAGE_SYSTEM_PROMPT === "true";
}

export function getSystemInjections() {
  const injections = {};
  for (const provider of ALL_PROVIDERS) {
    const val = process.env[`SYSTEM_INJECT_${provider.toUpperCase()}`];
    if (val) injections[provider] = val;
  }
  return injections;
}

export function getSimulatedFailures() {
  const raw = process.env.SIMULATE_FAILURES;
  if (!raw) return new Set();
  return new Set(raw.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean));
}

export function validateConfig() {
  const warnings = [];

  const rawOrder = process.env.PROVIDER_ORDER;
  if (rawOrder) {
    const parts = rawOrder.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
    const unknown = parts.filter((p) => !ALL_PROVIDERS.includes(p));
    if (unknown.length) {
      warnings.push(`PROVIDER_ORDER contains unknown provider name(s): ${unknown.join(", ")}. Valid: ${ALL_PROVIDERS.join(", ")}`);
    }
  }

  const keys = getApiKeys();
  for (const [provider, key] of Object.entries(keys)) {
    if (!key) continue;
    if (/\s/.test(key)) {
      warnings.push(`${provider.toUpperCase()}_API_KEY appears to contain whitespace — check for accidental copy-paste of quotes or newlines.`);
    }
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
      warnings.push(`${provider.toUpperCase()}_API_KEY appears to be wrapped in quotes — remove them.`);
    }
  }

  if (keys.cloudflare && !process.env.CLOUDFLARE_ACCOUNT_ID) {
    warnings.push("CLOUDFLARE_API_TOKEN is set but CLOUDFLARE_ACCOUNT_ID is missing — Cloudflare calls will fail.");
  }

  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (webhook && !/^https:\/\/discord(app)?\.com\/api\/webhooks\//.test(webhook)) {
    warnings.push("DISCORD_WEBHOOK_URL does not look like a valid Discord webhook URL.");
  }

  const numericVars = [
    "PROVIDER_COOLDOWN_MS", "CACHE_TTL_MS",
    "TIMEOUT_GEMINI_MS", "TIMEOUT_GROQ_MS", "TIMEOUT_OPENROUTER_MS",
    "TIMEOUT_CLOUDFLARE_MS", "TIMEOUT_SAMBANOVA_MS", "TIMEOUT_COHERE_MS", "TIMEOUT_MISTRAL_MS",
    "MAX_PROMPT_CHARS", "PROVIDER_WARMUP_INTERVAL_MS",
  ];
  for (const varName of numericVars) {
    const raw = process.env[varName];
    if (raw !== undefined && raw !== "" && isNaN(parseInt(raw, 10))) {
      warnings.push(`${varName}="${raw}" is not a valid number — the default will be used instead.`);
    }
  }

  const aliases = getProviderAliases();
  for (const [alias, target] of Object.entries(aliases)) {
    if (!ALL_PROVIDERS.includes(target)) {
      warnings.push(`ALIAS_${alias.toUpperCase()}="${target}" does not match any known provider (${ALL_PROVIDERS.join(", ")}).`);
    }
  }

  if (!Object.values(keys).some(Boolean)) {
    warnings.push("No provider API keys are configured at all.");
  }

  return warnings;
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
