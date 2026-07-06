/**
 * providers/groq.js
 * Calls the Groq API (OpenAI-compatible) and returns a normalized response.
 *
 * Supported free-tier models (default first):
 *   llama-3.3-70b-versatile, llama-3.1-8b-instant, mixtral-8x7b-32768, gemma2-9b-it
 */

import { normalizeSuccess, ProviderError } from "../lib/normalize.js";
import { getTimeout } from "../lib/config.js";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
export const DEFAULT_MODEL = "llama-3.3-70b-versatile";

export const SUPPORTED_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "mixtral-8x7b-32768",
  "gemma2-9b-it",
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
export async function callGroq({ prompt, systemPrompt, maxTokens, temperature, model = DEFAULT_MODEL, apiKey }) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const body = { model, messages, max_tokens: maxTokens, temperature };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeout("groq"));

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err.name === "AbortError" ? "Request timed out after " + getTimeout("groq") + "ms" : String(err.message);
    throw new ProviderError(`Groq network/timeout error: ${msg}`, null, "groq", msg);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const bodyText = (await response.text().catch(() => "")).slice(0, 500);
    throw new ProviderError(`Groq returned HTTP ${response.status}`, response.status, "groq", bodyText);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new ProviderError("Groq response missing expected text field", response.status, "groq", JSON.stringify(data).slice(0, 500));
  }

  const usage = {
    promptTokens: data?.usage?.prompt_tokens ?? 0,
    completionTokens: data?.usage?.completion_tokens ?? 0,
  };

  return normalizeSuccess(text, "groq", model, usage);
}
