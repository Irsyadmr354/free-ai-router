/**
 * providers/gemini.js
 * Calls the Google Gemini API and returns a normalized response.
 *
 * Supported free-tier models (default first):
 *   gemini-2.5-flash, gemini-2.0-flash, gemini-1.5-flash, gemini-1.5-flash-8b
 */

import { normalizeSuccess, normalizeEmbedding, ProviderError } from "../lib/normalize.js";
import { getTimeout } from "../lib/config.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
export const DEFAULT_MODEL = "gemini-2.5-flash";
export const DEFAULT_EMBED_MODEL = "text-embedding-004";

export const SUPPORTED_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
];

/**
 * @param {object} p
 * @param {string} p.prompt
 * @param {string} [p.systemPrompt]
 * @param {number} p.maxTokens
 * @param {number} p.temperature
 * @param {string} [p.model]
 * @param {string} p.apiKey
 */
export async function callGemini({ prompt, systemPrompt, maxTokens, temperature, model = DEFAULT_MODEL, apiKey }) {
  const url = `${BASE}/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature },
  };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };

  const response = await doFetch("gemini", url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    throw new ProviderError("Gemini response missing expected text field", response.status, "gemini", JSON.stringify(data).slice(0, 500));
  }

  const usage = {
    promptTokens: data?.usageMetadata?.promptTokenCount ?? 0,
    completionTokens: data?.usageMetadata?.candidatesTokenCount ?? 0,
  };

  return normalizeSuccess(text, "gemini", model, usage);
}

/**
 * Generate an embedding vector.
 * @param {object} p
 * @param {string} p.text
 * @param {string} [p.model]
 * @param {string} p.apiKey
 */
export async function embedGemini({ text, model = DEFAULT_EMBED_MODEL, apiKey }) {
  const url = `${BASE}/${model}:embedContent?key=${apiKey}`;
  const body = { model: `models/${model}`, content: { parts: [{ text }] } };

  const response = await doFetch("gemini", url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  const embedding = data?.embedding?.values;
  if (!Array.isArray(embedding)) {
    throw new ProviderError("Gemini embed response missing values", response.status, "gemini", JSON.stringify(data).slice(0, 500));
  }
  return normalizeEmbedding(embedding, "gemini", model);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function doFetch(provider, url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeout(provider));

  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err.name === "AbortError" ? "Request timed out after " + getTimeout(provider) + "ms" : String(err.message);
    throw new ProviderError(`Gemini network/timeout error: ${msg}`, null, "gemini", msg);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const bodyText = (await response.text().catch(() => "")).slice(0, 500);
    throw new ProviderError(`Gemini returned HTTP ${response.status}`, response.status, "gemini", bodyText);
  }

  return response;
}
