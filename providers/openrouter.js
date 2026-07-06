/**
 * providers/openrouter.js
 * Calls the OpenRouter API (OpenAI-compatible) and returns a normalized response.
 *
 * Use model = "openrouter/auto" to let OpenRouter pick the best free model,
 * or specify any model slug available on openrouter.ai (filter by "free" tier).
 */

import { normalizeSuccess, normalizeEmbedding, ProviderError } from "../lib/normalize.js";
import { getTimeout } from "../lib/config.js";

const CHAT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const EMBED_ENDPOINT = "https://openrouter.ai/api/v1/embeddings";
export const DEFAULT_MODEL = "openrouter/auto";

export const SUPPORTED_MODELS = [
  "openrouter/auto",
  "mistralai/mistral-7b-instruct:free",
  "meta-llama/llama-3.2-3b-instruct:free",
  "qwen/qwen-2.5-72b-instruct:free",
  "google/gemma-3-27b-it:free",
];

const HEADERS = (apiKey) => ({
  "Authorization": `Bearer ${apiKey}`,
  "Content-Type": "application/json",
  "HTTP-Referer": "https://localhost",
  "X-Title": "free-ai-router",
});

/**
 * @param {object} p
 * @param {string} p.prompt
 * @param {string} [p.systemPrompt]
 * @param {number} p.maxTokens
 * @param {number} p.temperature
 * @param {string} [p.model]
 * @param {string} p.apiKey
 */
export async function callOpenRouter({ prompt, systemPrompt, maxTokens, temperature, model = DEFAULT_MODEL, apiKey }) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const body = { model, messages, max_tokens: maxTokens, temperature };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeout("openrouter"));

  let response;
  try {
    response = await fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: HEADERS(apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err.name === "AbortError" ? "Request timed out after " + getTimeout("openrouter") + "ms" : String(err.message);
    throw new ProviderError(`OpenRouter network/timeout error: ${msg}`, null, "openrouter", msg);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const bodyText = (await response.text().catch(() => "")).slice(0, 500);
    throw new ProviderError(`OpenRouter returned HTTP ${response.status}`, response.status, "openrouter", bodyText);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new ProviderError("OpenRouter response missing expected text field", response.status, "openrouter", JSON.stringify(data).slice(0, 500));
  }

  // OpenRouter returns the actual model used (may differ from requested when using "auto")
  const actualModel = data?.model ?? model;
  const usage = {
    promptTokens: data?.usage?.prompt_tokens ?? 0,
    completionTokens: data?.usage?.completion_tokens ?? 0,
  };

  return normalizeSuccess(text, "openrouter", actualModel, usage);
}

/**
 * Generate an embedding vector via OpenRouter.
 * @param {object} p
 * @param {string} p.text
 * @param {string} [p.model]
 * @param {string} p.apiKey
 */
export async function embedOpenRouter({ text, model = "openai/text-embedding-3-small", apiKey }) {
  const body = { model, input: text };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeout("openrouter"));

  let response;
  try {
    response = await fetch(EMBED_ENDPOINT, {
      method: "POST",
      headers: HEADERS(apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err.name === "AbortError" ? "Request timed out" : String(err.message);
    throw new ProviderError(`OpenRouter embed network/timeout error: ${msg}`, null, "openrouter", msg);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const bodyText = (await response.text().catch(() => "")).slice(0, 500);
    throw new ProviderError(`OpenRouter embed returned HTTP ${response.status}`, response.status, "openrouter", bodyText);
  }

  const data = await response.json();
  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new ProviderError("OpenRouter embed response missing values", response.status, "openrouter", JSON.stringify(data).slice(0, 500));
  }
  return normalizeEmbedding(embedding, "openrouter", model);
}
