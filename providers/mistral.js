/**
 * providers/mistral.js
 * Calls the Mistral AI API (OpenAI-compatible).
 * Free tier: "Le Chat" experimental models via API key.
 *
 * Supported free-tier models (default first):
 *   mistral-small-latest, open-mistral-nemo, open-mistral-7b, open-mixtral-8x7b
 */

import { normalizeSuccess, ProviderError } from "../lib/normalize.js";
import { getTimeout } from "../lib/config.js";

const ENDPOINT = "https://api.mistral.ai/v1/chat/completions";
export const DEFAULT_MODEL = "mistral-small-latest";

export const SUPPORTED_MODELS = [
  "mistral-small-latest",
  "open-mistral-nemo",
  "open-mistral-7b",
  "open-mixtral-8x7b",
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
export async function callMistral({ prompt, systemPrompt, maxTokens, temperature, model = DEFAULT_MODEL, apiKey }) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const body = { model, messages, max_tokens: maxTokens, temperature };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeout("mistral"));

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err.name === "AbortError" ? "Request timed out after " + getTimeout("mistral") + "ms" : String(err.message);
    throw new ProviderError(`Mistral network/timeout error: ${msg}`, null, "mistral", msg);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const bodyText = (await response.text().catch(() => "")).slice(0, 500);
    throw new ProviderError(`Mistral returned HTTP ${response.status}`, response.status, "mistral", bodyText);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new ProviderError("Mistral response missing expected text field", response.status, "mistral", JSON.stringify(data).slice(0, 500));
  }

  const usage = {
    promptTokens: data?.usage?.prompt_tokens ?? 0,
    completionTokens: data?.usage?.completion_tokens ?? 0,
  };

  return normalizeSuccess(text, "mistral", model, usage);
}
