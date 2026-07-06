/**
 * providers/cloudflare.js
 * Calls Cloudflare Workers AI via the REST API.
 * Free tier: 10,000 neurons/day (~10k tokens).
 *
 * Requires: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID env vars.
 *
 * Supported free models (default first):
 *   @cf/meta/llama-3.3-70b-instruct-fp8-fast
 *   @cf/meta/llama-3.1-8b-instruct
 *   @cf/mistral/mistral-7b-instruct-v0.1
 *   @cf/google/gemma-7b-it
 */

import { normalizeSuccess, ProviderError } from "../lib/normalize.js";
import { getTimeout } from "../lib/config.js";

export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export const SUPPORTED_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/mistral/mistral-7b-instruct-v0.1",
  "@cf/google/gemma-7b-it",
];

/**
 * @param {object} p
 * @param {string} p.prompt
 * @param {string} [p.systemPrompt]
 * @param {number} p.maxTokens
 * @param {number} p.temperature
 * @param {string} [p.model]
 * @param {string} p.apiKey   - Cloudflare API Token
 */
export async function callCloudflare({ prompt, systemPrompt, maxTokens, temperature, model = DEFAULT_MODEL, apiKey }) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    throw new ProviderError(
      "Cloudflare CLOUDFLARE_ACCOUNT_ID env var is not set",
      null,
      "cloudflare",
      "Missing CLOUDFLARE_ACCOUNT_ID"
    );
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const body = { messages, max_tokens: maxTokens, temperature };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeout("cloudflare"));

  let response;
  try {
    response = await fetch(url, {
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
    const msg = err.name === "AbortError" ? "Request timed out after " + getTimeout("cloudflare") + "ms" : String(err.message);
    throw new ProviderError(`Cloudflare network/timeout error: ${msg}`, null, "cloudflare", msg);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const bodyText = (await response.text().catch(() => "")).slice(0, 500);
    throw new ProviderError(`Cloudflare returned HTTP ${response.status}`, response.status, "cloudflare", bodyText);
  }

  const data = await response.json();

  // Cloudflare wraps result in { success: true, result: { response: "..." } }
  const text = data?.result?.response;
  if (typeof text !== "string") {
    throw new ProviderError("Cloudflare response missing expected text field", response.status, "cloudflare", JSON.stringify(data).slice(0, 500));
  }

  return normalizeSuccess(text, "cloudflare", model, { promptTokens: 0, completionTokens: 0 });
}
