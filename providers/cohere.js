/**
 * providers/cohere.js
 * Calls Cohere's Chat API.
 * Free tier: 1,000 calls/month on the Trial key.
 *
 * Supported free-tier models (default first):
 *   command-r, command-r-plus, command-light
 */

import { normalizeSuccess, ProviderError } from "../lib/normalize.js";
import { getTimeout } from "../lib/config.js";

const ENDPOINT = "https://api.cohere.com/v2/chat";
export const DEFAULT_MODEL = "command-r";

export const SUPPORTED_MODELS = ["command-r", "command-r-plus", "command-light"];

/**
 * @param {object} p
 * @param {string} p.prompt
 * @param {string} [p.systemPrompt]
 * @param {number} p.maxTokens
 * @param {number} p.temperature
 * @param {string} [p.model]
 * @param {string} p.apiKey
 */
export async function callCohere({ prompt, systemPrompt, maxTokens, temperature, model = DEFAULT_MODEL, apiKey }) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const body = { model, messages, max_tokens: maxTokens, temperature };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeout("cohere"));

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err.name === "AbortError" ? "Request timed out after " + getTimeout("cohere") + "ms" : String(err.message);
    throw new ProviderError(`Cohere network/timeout error: ${msg}`, null, "cohere", msg);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const bodyText = (await response.text().catch(() => "")).slice(0, 500);
    throw new ProviderError(`Cohere returned HTTP ${response.status}`, response.status, "cohere", bodyText);
  }

  const data = await response.json();

  // Cohere v2 chat: message.content is an array of content blocks
  const text = data?.message?.content?.[0]?.text ?? data?.message?.content;
  if (typeof text !== "string") {
    throw new ProviderError("Cohere response missing expected text field", response.status, "cohere", JSON.stringify(data).slice(0, 500));
  }

  const usage = {
    promptTokens: data?.usage?.tokens?.input_tokens ?? 0,
    completionTokens: data?.usage?.tokens?.output_tokens ?? 0,
  };

  return normalizeSuccess(text, "cohere", model, usage);
}
