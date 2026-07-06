/**
 * providers/opencode-zen.js
 * Calls the OpenCode Zen API (OpenAI-compatible) and returns a normalized response.
 *
 * OpenCode Zen is a curated gateway of tested, verified models.
 * Free-tier models available via OPENCODE_API_KEY.
 *
 * ⚠️  The free models (DeepSeek V4 Flash Free, MiMo-V2.5 Free, etc.) are
 * available for a limited time. Models are auto-synced from the OpenCode Zen
 * API at startup — no manual updates needed if they change.
 *
 * API docs: https://opencode.ai/zen
 */

import { normalizeSuccess, ProviderError } from "../lib/normalize.js";
import { getTimeout } from "../lib/config.js";
import { consumeOpenAiSse } from "../lib/sse.js";
import { log, logError } from "../lib/logger.js";

const CHAT_ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const MODELS_ENDPOINT = "https://opencode.ai/zen/v1/models";
export const DEFAULT_MODEL = "deepseek-v4-flash-free";

const HARDCODED_MODELS = [
  "deepseek-v4-flash-free",
  "nemotron-3-ultra-free",
  "mimo-v2.5-free",
  "north-mini-code-free",
  "big-pickle",
];

export let SUPPORTED_MODELS = [...HARDCODED_MODELS];

let synced = false;

/**
 * Fetch the live model list from OpenCode Zen API and update SUPPORTED_MODELS.
 * Filters to free models (model IDs ending with "-free" or named "big-pickle").
 * Falls back to HARDCODED_MODELS if the API is unreachable.
 * Call once at startup.
 */
export async function syncModels(apiKey) {
  if (synced) return;
  synced = true;

  try {
    const res = await fetch(MODELS_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const liveFreeModels = (data.data ?? [])
      .map((m) => m.id)
      .filter((id) => id.endsWith("-free") || id === "big-pickle");

    if (liveFreeModels.length > 0) {
      SUPPORTED_MODELS = liveFreeModels;
      log(`OpenCode Zen: synced ${liveFreeModels.length} free models (${liveFreeModels.join(", ")})`);
    }
  } catch (err) {
    logError(`OpenCode Zen: model sync failed (${err.message}), using hardcoded list`);
    SUPPORTED_MODELS = [...HARDCODED_MODELS];
  }
}

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
export async function callOpenCodeZen({ prompt, systemPrompt, maxTokens, temperature, model = DEFAULT_MODEL, apiKey, stream = false, tools, toolChoice, responseFormat, messages: providedMessages }) {
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
  const timeoutId = setTimeout(() => controller.abort(), getTimeout("opencode-zen"));

  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(CHAT_ENDPOINT, {
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
      ? "Request timed out after " + getTimeout("opencode-zen") + "ms"
      : String(err.message);
    throw new ProviderError(`OpenCode Zen network/timeout error: ${msg}`, null, "opencode-zen", msg);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const bodyText = (await response.text().catch(() => "")).slice(0, 500);
    throw new ProviderError(`OpenCode Zen returned HTTP ${response.status}`, response.status, "opencode-zen", bodyText);
  }

  if (stream) {
    let firstChunkMs = null;
    const { fullText, finalUsage, finalModel } = await consumeOpenAiSse(
      response,
      () => {},
      () => { firstChunkMs = Date.now() - startedAt; }
    );

    if (!fullText) {
      throw new ProviderError("OpenCode Zen streamed response was empty", response.status, "opencode-zen", "No content deltas received");
    }

    const usage = {
      promptTokens: finalUsage?.prompt_tokens ?? 0,
      completionTokens: finalUsage?.completion_tokens ?? 0,
    };

    return normalizeSuccess(fullText, "opencode-zen", finalModel ?? model, usage, { firstChunkMs, streamed: true });
  }

  const data = await response.json();
  const message = data?.choices?.[0]?.message;
  const text = message?.content;
  const toolCalls = message?.tool_calls;

  if (typeof text !== "string" && !toolCalls?.length) {
    throw new ProviderError("OpenCode Zen response missing expected text field", response.status, "opencode-zen", JSON.stringify(data).slice(0, 500));
  }

  const usage = {
    promptTokens: data?.usage?.prompt_tokens ?? 0,
    completionTokens: data?.usage?.completion_tokens ?? 0,
  };

  const result = normalizeSuccess(text ?? "", "opencode-zen", model, usage, { streamed: false });
  if (toolCalls?.length) result.toolCalls = toolCalls;
  return result;
}

/**
 * Streaming variant — forwards each content delta via onDelta(text).
 */
export async function streamOpenCodeZen({ prompt, systemPrompt, maxTokens, temperature, model = DEFAULT_MODEL, apiKey, tools, toolChoice, responseFormat, messages: providedMessages, onDelta, abortSignal }) {
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
  const timeoutId = setTimeout(() => controller.abort(), getTimeout("opencode-zen"));
  if (abortSignal) abortSignal.addEventListener("abort", () => controller.abort(), { once: true });

  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(CHAT_ENDPOINT, {
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
      ? "Request timed out after " + getTimeout("opencode-zen") + "ms"
      : String(err.message);
    throw new ProviderError(`OpenCode Zen network/timeout error: ${msg}`, null, "opencode-zen", msg);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const bodyText = (await response.text().catch(() => "")).slice(0, 500);
    throw new ProviderError(`OpenCode Zen returned HTTP ${response.status}`, response.status, "opencode-zen", bodyText);
  }

  let firstChunkMs = null;
  const { fullText, finalUsage, finalModel } = await consumeOpenAiSse(
    response,
    (delta) => onDelta?.(delta),
    () => { firstChunkMs = Date.now() - startedAt; }
  );

  if (!fullText) {
    throw new ProviderError("OpenCode Zen streamed response was empty", response.status, "opencode-zen", "No content deltas received");
  }

  const usage = {
    promptTokens: finalUsage?.prompt_tokens ?? 0,
    completionTokens: finalUsage?.completion_tokens ?? 0,
  };

  return normalizeSuccess(fullText, "opencode-zen", finalModel ?? model, usage, { firstChunkMs, streamed: true });
}
