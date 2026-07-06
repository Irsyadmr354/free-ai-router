/**
 * providers/openrouter.js
 * Calls the OpenRouter API (OpenAI-compatible) and returns a normalized response.
 *
 * IMPORTANT: Always use models with the ":free" suffix to stay on free tier.
 * NEVER use "openrouter/auto" — it is not a valid model ID and causes OpenRouter
 * to silently route to a paid model.
 *
 * Free models: https://openrouter.ai/models?q=:free
 */

import { normalizeSuccess, normalizeEmbedding, ProviderError } from "../lib/normalize.js";
import { getTimeout } from "../lib/config.js";
import { consumeOpenAiSse } from "../lib/sse.js";

const CHAT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const EMBED_ENDPOINT = "https://openrouter.ai/api/v1/embeddings";
export const DEFAULT_MODEL = "meta-llama/llama-3.2-3b-instruct:free";

export const SUPPORTED_MODELS = [
  "meta-llama/llama-3.2-3b-instruct:free",
  "mistralai/mistral-7b-instruct:free",
  "qwen/qwen-2.5-72b-instruct:free",
  "google/gemma-3-27b-it:free",
  "microsoft/phi-4-reasoning:free",
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
 * @param {boolean} [p.stream]
 */
export async function callOpenRouter({ prompt, systemPrompt, maxTokens, temperature, model = DEFAULT_MODEL, apiKey, stream = false, tools, toolChoice, responseFormat, messages: providedMessages }) {
  const messages = providedMessages ?? [];
  if (!providedMessages) {
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });
  }

  const body = { model, messages, max_tokens: maxTokens, temperature, stream };
  if (tools?.length) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }
  if (responseFormat === "json") {
    body.response_format = { type: "json_object" };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeout("openrouter"));

  const startedAt = Date.now();
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

  if (stream) {
    let firstChunkMs = null;
    const { fullText, finalUsage, finalModel } = await consumeOpenAiSse(
      response,
      () => {},
      () => { firstChunkMs = Date.now() - startedAt; }
    );

    if (!fullText) {
      throw new ProviderError("OpenRouter streamed response was empty", response.status, "openrouter", "No content deltas received");
    }

    const usage = {
      promptTokens: finalUsage?.prompt_tokens ?? 0,
      completionTokens: finalUsage?.completion_tokens ?? 0,
    };

    return normalizeSuccess(fullText, "openrouter", finalModel ?? model, usage, { firstChunkMs, streamed: true });
  }

  const data = await response.json();
  const message = data?.choices?.[0]?.message;
  const text = message?.content;
  const toolCalls = message?.tool_calls;
  if (typeof text !== "string" && !toolCalls?.length) {
    throw new ProviderError("OpenRouter response missing expected text field", response.status, "openrouter", JSON.stringify(data).slice(0, 500));
  }

  // OpenRouter returns the actual model used (may differ from requested when using "auto")
  const actualModel = data?.model ?? model;
  const usage = {
    promptTokens: data?.usage?.prompt_tokens ?? 0,
    completionTokens: data?.usage?.completion_tokens ?? 0,
  };

  const result = normalizeSuccess(text ?? "", "openrouter", actualModel, usage, { streamed: false });
  if (toolCalls?.length) result.toolCalls = toolCalls;
  return result;
}

/**
 * Real streaming variant — forwards each content delta to onDelta(text) as
 * it arrives from OpenRouter, instead of collecting the full text before
 * returning. Used by http-server.js for true SSE forwarding to clients.
 *
 * @param {object} p - same shape as callOpenRouter(), plus:
 * @param {(text: string) => void} p.onDelta - called per content delta
 * @param {AbortSignal} [p.abortSignal] - external abort (e.g. client disconnect)
 */
export async function streamOpenRouter({ prompt, systemPrompt, maxTokens, temperature, model = DEFAULT_MODEL, apiKey, tools, toolChoice, responseFormat, messages: providedMessages, onDelta, abortSignal }) {
  const messages = providedMessages ?? [];
  if (!providedMessages) {
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });
  }

  const body = { model, messages, max_tokens: maxTokens, temperature, stream: true };
  if (tools?.length) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }
  if (responseFormat === "json") {
    body.response_format = { type: "json_object" };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeout("openrouter"));
  if (abortSignal) abortSignal.addEventListener("abort", () => controller.abort(), { once: true });

  const startedAt = Date.now();
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

  let firstChunkMs = null;
  const { fullText, finalUsage, finalModel } = await consumeOpenAiSse(
    response,
    (delta) => onDelta?.(delta),
    () => { firstChunkMs = Date.now() - startedAt; }
  );

  if (!fullText) {
    throw new ProviderError("OpenRouter streamed response was empty", response.status, "openrouter", "No content deltas received");
  }

  const usage = {
    promptTokens: finalUsage?.prompt_tokens ?? 0,
    completionTokens: finalUsage?.completion_tokens ?? 0,
  };

  return normalizeSuccess(fullText, "openrouter", finalModel ?? model, usage, { firstChunkMs, streamed: true });
}

/**
 * Generate an embedding vector via OpenRouter.
 * @param {object} p
 * @param {string} p.text
 * @param {string} [p.model]
 * @param {string} p.apiKey
 */
export async function embedOpenRouter({ text, model = "mistralai/mistral-embed", apiKey }) {
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
