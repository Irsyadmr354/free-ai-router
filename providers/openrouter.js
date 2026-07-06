/**
 * providers/openrouter.js
 * Calls the OpenRouter API (OpenAI-compatible) and returns a normalized response.
 *
 * "openrouter/free" is an official OpenRouter router that randomly selects from
 * all 25+ free models available on OpenRouter. It is free, valid, and recommended.
 * https://openrouter.ai/openrouter/free
 *
 * At startup, syncFreeModels() fetches the live free model list from the
 * OpenRouter API and updates SUPPORTED_MODELS so the list stays current
 * without manual updates.
 */

import { normalizeSuccess, normalizeEmbedding, ProviderError } from "../lib/normalize.js";
import { getTimeout, getStreamTimeout } from "../lib/config.js";
import { consumeOpenAiSse } from "../lib/sse.js";
import { log, logError } from "../lib/logger.js";

const CHAT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const EMBED_ENDPOINT = "https://openrouter.ai/api/v1/embeddings";
const MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";
export const DEFAULT_MODEL = "openrouter/free";

// Hardcoded fallback — used if the live fetch fails at startup.
const HARDCODED_FREE_MODELS = [
  "openrouter/free",
  "meta-llama/llama-3.2-3b-instruct:free",
  "mistralai/mistral-7b-instruct:free",
  "qwen/qwen-2.5-72b-instruct:free",
  "google/gemma-3-27b-it:free",
  "microsoft/phi-4-reasoning:free",
];

export let SUPPORTED_MODELS = [...HARDCODED_FREE_MODELS];

let syncedOpenRouter = false;

async function notifyModelDeprecation(previousCount, currentCount) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  const payload = {
    username: "free-ai-router",
    embeds: [{
      title: "⚠️ OpenRouter free model count dropped",
      description: `Free model count fell from ${previousCount} to ${currentCount} after a resync — OpenRouter may have deprecated or repriced some models. Check https://openrouter.ai/models?max_price=0 if fallback chain reliability drops.`,
      color: 0xffaa00,
      timestamp: new Date().toISOString(),
    }],
  };
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // best-effort only
  }
}

/**
 * Fetch the live model list from OpenRouter and update SUPPORTED_MODELS with
 * all models that are genuinely free (pricing.prompt === "0" on OpenRouter's API).
 * Always keeps "openrouter/free" at index 0.
 * Falls back to HARDCODED_FREE_MODELS if the API is unreachable.
 * Safe to call once at startup without an API key — OpenRouter's /models endpoint
 * is public and does not require authentication.
 */
export async function syncFreeModels() {
  if (syncedOpenRouter) return;
  syncedOpenRouter = true;

  try {
    const res = await fetch(MODELS_ENDPOINT, {
      headers: { "HTTP-Referer": "https://localhost", "X-Title": "free-ai-router" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // OpenRouter marks free models with pricing.prompt === "0" (string)
    const freeModels = (data.data ?? [])
      .filter((m) => m.pricing?.prompt === "0" && m.pricing?.completion === "0")
      .map((m) => m.id)
      .filter((id) => id && id !== "openrouter/free"); // dedupe the special router

    if (freeModels.length > 0) {
      // Detect a significant drop in free model count vs the previous synced
      // list (excluding the special "openrouter/free" router entry itself) —
      // could indicate OpenRouter deprecating/removing free models, which
      // would silently shrink the router's fallback options.
      const previousCount = SUPPORTED_MODELS.filter((m) => m !== "openrouter/free").length;
      if (previousCount > 0) {
        const dropRatio = (previousCount - freeModels.length) / previousCount;
        if (dropRatio > 0.2) {
          const msg = `OpenRouter: free model count dropped ${(dropRatio * 100).toFixed(0)}% (${previousCount} → ${freeModels.length}) — possible model deprecation`;
          logError(msg);
          notifyModelDeprecation(previousCount, freeModels.length).catch(() => {});
        }
      }

      // Always keep openrouter/free first as the default catch-all
      SUPPORTED_MODELS = ["openrouter/free", ...freeModels];
      log(`OpenRouter: synced ${freeModels.length} free models from live API`);
    } else {
      SUPPORTED_MODELS = [...HARDCODED_FREE_MODELS];
      log(`OpenRouter: no free models found in API response, using hardcoded list`);
    }
  } catch (err) {
    logError(`OpenRouter: model sync failed (${err.message}), using hardcoded list`);
    SUPPORTED_MODELS = [...HARDCODED_FREE_MODELS];
  }
}

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
  const choice = data?.choices?.[0];
  const message = choice?.message;
  const toolCalls = message?.tool_calls;
  // Some upstream OpenRouter models (esp. via the "openrouter/free" router,
  // which can land on providers like Poolside) return content as `null`
  // instead of an empty string when the response was filtered/refused, or
  // omit `message` entirely on certain finish_reasons. Treat those as an
  // empty completion rather than a hard parse failure — only truly missing
  // `choices`/`message` structure (i.e. broken response shape) is fatal.
  const text = typeof message?.content === "string" ? message.content : "";
  if (!choice || (message === undefined)) {
    throw new ProviderError("OpenRouter response missing expected message field", response.status, "openrouter", JSON.stringify(data).slice(0, 500));
  }
  if (!text && !toolCalls?.length) {
    throw new ProviderError(`OpenRouter response had no text or tool calls (finish_reason: ${choice?.finish_reason ?? "unknown"})`, response.status, "openrouter", JSON.stringify(data).slice(0, 500));
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
  const streamTimeoutMs = getStreamTimeout("openrouter");
  const timeoutId = setTimeout(() => controller.abort(), streamTimeoutMs);
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
    const msg = err.name === "AbortError" ? "Request timed out after " + streamTimeoutMs + "ms" : String(err.message);
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
