/**
 * providers/sambanova.js
 * Calls SambaNova Cloud API (OpenAI-compatible).
 *
 * Free tier (no payment method needed):
 *   - Meta-Llama-3.3-70B-Instruct : 48,000 req/day
 *   - DeepSeek-V3.1                : 12,000 req/day
 *   - gpt-oss-120b                 : 12,000 req/day
 *   - gemma-4-31B-it (preview)     : 12,000 req/day
 *
 * Get your API key at: https://cloud.sambanova.ai/apis
 */

import { normalizeSuccess, ProviderError } from "../lib/normalize.js";
import { getTimeout } from "../lib/config.js";
import { consumeOpenAiSse } from "../lib/sse.js";

const ENDPOINT = "https://api.sambanova.ai/v1/chat/completions";
export const DEFAULT_MODEL = "Meta-Llama-3.3-70B-Instruct";

export const SUPPORTED_MODELS = [
  "Meta-Llama-3.3-70B-Instruct",
  "DeepSeek-V3.1",
  "gpt-oss-120b",
  "gemma-4-31B-it",
];

/**
 * @param {object} p
 * @param {string} p.prompt
 * @param {string} [p.systemPrompt]
 * @param {number} p.maxTokens
 * @param {number} p.temperature
 * @param {string} [p.model]
 * @param {string} p.apiKey
 * @param {boolean} [p.stream]
 */
export async function callSambaNova({ prompt, systemPrompt, maxTokens, temperature, model = DEFAULT_MODEL, apiKey, stream = false }) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const body = { model, messages, max_tokens: maxTokens, temperature, stream };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeout("sambanova"));

  const startedAt = Date.now();
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
    const msg = err.name === "AbortError"
      ? "Request timed out after " + getTimeout("sambanova") + "ms"
      : String(err.message);
    throw new ProviderError(`SambaNova network/timeout error: ${msg}`, null, "sambanova", msg);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const bodyText = (await response.text().catch(() => "")).slice(0, 500);
    throw new ProviderError(`SambaNova returned HTTP ${response.status}`, response.status, "sambanova", bodyText);
  }

  if (stream) {
    let firstChunkMs = null;
    const { fullText, finalUsage, finalModel } = await consumeOpenAiSse(
      response,
      () => {},
      () => { firstChunkMs = Date.now() - startedAt; }
    );

    if (!fullText) {
      throw new ProviderError("SambaNova streamed response was empty", response.status, "sambanova", "No content deltas received");
    }

    const usage = {
      promptTokens: finalUsage?.prompt_tokens ?? 0,
      completionTokens: finalUsage?.completion_tokens ?? 0,
    };

    return normalizeSuccess(fullText, "sambanova", finalModel ?? model, usage, { firstChunkMs, streamed: true });
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new ProviderError(
      "SambaNova response missing expected text field",
      response.status,
      "sambanova",
      JSON.stringify(data).slice(0, 500)
    );
  }

  const usage = {
    promptTokens: data?.usage?.prompt_tokens ?? 0,
    completionTokens: data?.usage?.completion_tokens ?? 0,
  };

  return normalizeSuccess(text, "sambanova", model, usage, { streamed: false });
}

/**
 * Real streaming variant — forwards each content delta to onDelta(text) as
 * it arrives from SambaNova, instead of collecting the full text before
 * returning. Used by http-server.js for true SSE forwarding to clients.
 *
 * @param {object} p - same shape as callSambaNova(), plus:
 * @param {(text: string) => void} p.onDelta - called per content delta
 * @param {AbortSignal} [p.abortSignal] - external abort (e.g. client disconnect)
 */
export async function streamSambaNova({ prompt, systemPrompt, maxTokens, temperature, model = DEFAULT_MODEL, apiKey, onDelta, abortSignal }) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const body = { model, messages, max_tokens: maxTokens, temperature, stream: true };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeout("sambanova"));
  if (abortSignal) abortSignal.addEventListener("abort", () => controller.abort(), { once: true });

  const startedAt = Date.now();
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
    const msg = err.name === "AbortError"
      ? "Request timed out after " + getTimeout("sambanova") + "ms"
      : String(err.message);
    throw new ProviderError(`SambaNova network/timeout error: ${msg}`, null, "sambanova", msg);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const bodyText = (await response.text().catch(() => "")).slice(0, 500);
    throw new ProviderError(`SambaNova returned HTTP ${response.status}`, response.status, "sambanova", bodyText);
  }

  let firstChunkMs = null;
  const { fullText, finalUsage, finalModel } = await consumeOpenAiSse(
    response,
    (delta) => onDelta?.(delta),
    () => { firstChunkMs = Date.now() - startedAt; }
  );

  if (!fullText) {
    throw new ProviderError("SambaNova streamed response was empty", response.status, "sambanova", "No content deltas received");
  }

  const usage = {
    promptTokens: finalUsage?.prompt_tokens ?? 0,
    completionTokens: finalUsage?.completion_tokens ?? 0,
  };

  return normalizeSuccess(fullText, "sambanova", finalModel ?? model, usage, { firstChunkMs, streamed: true });
}
