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
 *
 * Streaming: supported via `stream: true` in request body.
 * Cloudflare's REST /ai/run/ endpoint returns standard SSE (text/event-stream)
 * with data: {...} lines, same pattern as OpenAI-compatible providers.
 * Each SSE event has shape: { response: "token", p: "...", usage: {...} }
 * The final event is data: [DONE]
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

/**
 * "Streaming" variant for Cloudflare Workers AI.
 * Uses `stream: true` in the request body — Cloudflare's REST /ai/run/
 * endpoint returns proper SSE (text/event-stream). Each event has shape:
 *   data: {"response":"token","p":"..."}
 * terminated by data: [DONE]
 *
 * @param {object} p - same shape as callCloudflare(), plus:
 * @param {(text: string) => void} p.onDelta - called per content token
 * @param {AbortSignal} [p.abortSignal]
 */
export async function streamCloudflare({ prompt, systemPrompt, maxTokens, temperature, model = DEFAULT_MODEL, apiKey, onDelta, abortSignal }) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    throw new ProviderError("Cloudflare CLOUDFLARE_ACCOUNT_ID env var is not set", null, "cloudflare", "Missing CLOUDFLARE_ACCOUNT_ID");
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const body = { messages, max_tokens: maxTokens, temperature, stream: true };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeout("cloudflare"));
  if (abortSignal) abortSignal.addEventListener("abort", () => controller.abort(), { once: true });

  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
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

  let fullText = "";
  let firstChunkMs = null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let json;
        try { json = JSON.parse(payload); } catch { continue; }

        // Cloudflare SSE event shape: { response: "token", p: "..." }
        const token = json?.response;
        if (typeof token === "string" && token.length > 0) {
          fullText += token;
          if (firstChunkMs === null) firstChunkMs = Date.now() - startedAt;
          onDelta?.(token);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!fullText) {
    throw new ProviderError("Cloudflare streamed response was empty", response.status, "cloudflare", "No response tokens received");
  }

  return normalizeSuccess(fullText, "cloudflare", model, { promptTokens: 0, completionTokens: 0 }, { firstChunkMs, streamed: true });
}
