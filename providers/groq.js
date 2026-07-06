/**
 * providers/groq.js
 * Calls the Groq API (OpenAI-compatible) and returns a normalized response.
 *
 * SUPPORTED_MODELS: full Groq model catalog (used for list_providers, model validation).
 * CHAT_MODELS: subset that actually supports chat/text-generation — used by the
 *   fallback chain so it never accidentally tries whisper, prompt-guard, or TTS
 *   models for a chat_completion call.
 *
 * Supports streaming (stream: true) — chunks are consumed server-side and
 * combined into a single response, but time-to-first-chunk is measured and
 * reported so callers can see real responsiveness, not just total latency.
 */

import { normalizeSuccess, ProviderError } from "../lib/normalize.js";
import { getTimeout } from "../lib/config.js";
import { consumeOpenAiSse } from "../lib/sse.js";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
export const DEFAULT_MODEL = "llama-3.3-70b-versatile";

/**
 * Full Groq model catalog — shown in list_providers / model validation.
 * Includes non-chat models for completeness.
 */
export const SUPPORTED_MODELS = [
  // Chat / text-generation
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "groq/compound",
  "groq/compound-mini",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "openai/gpt-oss-safeguard-20b",
  "qwen/qwen3-32b",
  "qwen/qwen3.6-27b",
  "allam-2-7b",
  // Canopy (voice/speech — not for chat fallback)
  "canopylabs/orpheus-arabic-saudi",
  "canopylabs/orpheus-v1-english",
  // Content moderation classifiers (not chat models)
  "meta-llama/llama-prompt-guard-2-22m",
  "meta-llama/llama-prompt-guard-2-86m",
  // Speech-to-text (not chat models)
  "whisper-large-v3",
  "whisper-large-v3-turbo",
];

/**
 * Subset of SUPPORTED_MODELS that are genuine chat/text-generation models.
 * The fallback chain uses this list — non-chat models are excluded so
 * whisper / prompt-guard / Orpheus are never tried for a chat request.
 */
export const CHAT_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "groq/compound",
  "groq/compound-mini",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3-32b",
  "qwen/qwen3.6-27b",
  "allam-2-7b",
];

/**
 * @param {object} p
 * @param {string} p.prompt
 * @param {string} [p.systemPrompt]
 * @param {number} p.maxTokens
 * @param {number} p.temperature
 * @param {string} [p.model]
 * @param {string} p.apiKey
 * @param {boolean} [p.stream] - if true, request as SSE and track time-to-first-chunk
 */
export async function callGroq({ prompt, systemPrompt, maxTokens, temperature, model = DEFAULT_MODEL, apiKey, stream = false, tools, toolChoice, responseFormat, messages: providedMessages }) {
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
  const timeoutId = setTimeout(() => controller.abort(), getTimeout("groq"));

  const startedAt = Date.now();
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

  if (stream) {
    let firstChunkMs = null;
    const { fullText, finalUsage, finalModel } = await consumeOpenAiSse(
      response,
      () => {}, // onChunk — nothing to forward to in this stdio context
      () => { firstChunkMs = Date.now() - startedAt; }
    );

    if (!fullText) {
      throw new ProviderError("Groq streamed response was empty", response.status, "groq", "No content deltas received");
    }

    const usage = {
      promptTokens: finalUsage?.prompt_tokens ?? 0,
      completionTokens: finalUsage?.completion_tokens ?? 0,
    };

    return normalizeSuccess(fullText, "groq", finalModel ?? model, usage, { firstChunkMs, streamed: true });
  }

  const data = await response.json();
  const message = data?.choices?.[0]?.message;
  const text = message?.content;
  const toolCalls = message?.tool_calls;

  // A tool-calling response may have empty/null content and only tool_calls —
  // that's a valid outcome when `tools` was passed, not a missing-field error.
  if (typeof text !== "string" && !toolCalls?.length) {
    throw new ProviderError("Groq response missing expected text field", response.status, "groq", JSON.stringify(data).slice(0, 500));
  }

  const usage = {
    promptTokens: data?.usage?.prompt_tokens ?? 0,
    completionTokens: data?.usage?.completion_tokens ?? 0,
  };

  const result = normalizeSuccess(text ?? "", "groq", model, usage, { streamed: false });
  if (toolCalls?.length) result.toolCalls = toolCalls;
  return result;
}

/**
 * Real streaming variant — forwards each content delta to onDelta(text) as
 * it arrives from Groq, instead of collecting the full text before
 * returning. Used by http-server.js for true SSE forwarding to clients.
 *
 * @param {object} p - same shape as callGroq(), plus:
 * @param {(text: string) => void} p.onDelta - called per content delta
 * @param {AbortSignal} [p.abortSignal] - external abort (e.g. client disconnect)
 */
export async function streamGroq({ prompt, systemPrompt, maxTokens, temperature, model = DEFAULT_MODEL, apiKey, tools, toolChoice, responseFormat, messages: providedMessages, onDelta, abortSignal }) {
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
  const timeoutId = setTimeout(() => controller.abort(), getTimeout("groq"));
  if (abortSignal) abortSignal.addEventListener("abort", () => controller.abort(), { once: true });

  const startedAt = Date.now();
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

  let firstChunkMs = null;
  const { fullText, finalUsage, finalModel } = await consumeOpenAiSse(
    response,
    (delta) => onDelta?.(delta),
    () => { firstChunkMs = Date.now() - startedAt; }
  );

  if (!fullText) {
    throw new ProviderError("Groq streamed response was empty", response.status, "groq", "No content deltas received");
  }

  const usage = {
    promptTokens: finalUsage?.prompt_tokens ?? 0,
    completionTokens: finalUsage?.completion_tokens ?? 0,
  };

  return normalizeSuccess(fullText, "groq", finalModel ?? model, usage, { firstChunkMs, streamed: true });
}
