/**
 * providers/cohere.js
 * Calls Cohere's Chat API.
 * Free tier: 1,000 calls/month on the Trial key.
 *
 * Supported free-tier models (default first):
 *   command-r, command-r-plus, command-light
 */

import { normalizeSuccess, ProviderError } from "../lib/normalize.js";
import { getTimeout, getStreamTimeout } from "../lib/config.js";

const ENDPOINT = "https://api.cohere.com/v2/chat";
export const DEFAULT_MODEL = "command-r-plus-08-2024";

export const SUPPORTED_MODELS = ["command-r-plus-08-2024", "command-r-08-2024", "command-light"];

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
export async function callCohere({ prompt, systemPrompt, maxTokens, temperature, model = DEFAULT_MODEL, apiKey, stream = false }) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const body = { model, messages, max_tokens: maxTokens, temperature, stream };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeout("cohere"));

  const startedAt = Date.now();
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

  if (stream) {
    let firstChunkMs = null;
    let fullText = "";
    let finalUsage = null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload) continue;

        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }

        // Cohere v2 streaming event shapes:
        //   { type: "content-delta", delta: { message: { content: { text: "..." } } } }
        //   { type: "message-end", delta: { usage: { tokens: { input_tokens, output_tokens } } } }
        if (json?.type === "content-delta") {
          const delta = json?.delta?.message?.content?.text;
          if (typeof delta === "string" && delta.length > 0) {
            fullText += delta;
            if (firstChunkMs === null) firstChunkMs = Date.now() - startedAt;
          }
        } else if (json?.type === "message-end") {
          finalUsage = json?.delta?.usage?.tokens ?? null;
        }
      }
    }

    if (!fullText) {
      throw new ProviderError("Cohere streamed response was empty", response.status, "cohere", "No content-delta events received");
    }

    const usage = {
      promptTokens: finalUsage?.input_tokens ?? 0,
      completionTokens: finalUsage?.output_tokens ?? 0,
    };

    return normalizeSuccess(fullText, "cohere", model, usage, { firstChunkMs, streamed: true });
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

  return normalizeSuccess(text, "cohere", model, usage, { streamed: false });
}

/**
 * Real streaming variant — forwards each content delta to onDelta(text) as
 * it arrives from Cohere, instead of collecting the full text before
 * returning. Used by http-server.js for true SSE forwarding to clients.
 * Cohere uses a custom v2 streaming event shape (not the OpenAI delta
 * format), so this reimplements the same manual SSE parsing as callCohere's
 * stream branch, with onDelta wired in at the same content-delta point.
 *
 * @param {object} p - same shape as callCohere(), plus:
 * @param {(text: string) => void} p.onDelta - called per content delta
 * @param {AbortSignal} [p.abortSignal] - external abort (e.g. client disconnect)
 */
export async function streamCohere({ prompt, systemPrompt, maxTokens, temperature, model = DEFAULT_MODEL, apiKey, onDelta, abortSignal }) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const body = { model, messages, max_tokens: maxTokens, temperature, stream: true };

  const controller = new AbortController();
  const streamTimeoutMs = getStreamTimeout("cohere");
  const timeoutId = setTimeout(() => controller.abort(), streamTimeoutMs);
  if (abortSignal) abortSignal.addEventListener("abort", () => controller.abort(), { once: true });

  const startedAt = Date.now();
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
    const msg = err.name === "AbortError" ? "Request timed out after " + streamTimeoutMs + "ms" : String(err.message);
    throw new ProviderError(`Cohere network/timeout error: ${msg}`, null, "cohere", msg);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const bodyText = (await response.text().catch(() => "")).slice(0, 500);
    throw new ProviderError(`Cohere returned HTTP ${response.status}`, response.status, "cohere", bodyText);
  }

  let firstChunkMs = null;
  let fullText = "";
  let finalUsage = null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }

      if (json?.type === "content-delta") {
        const delta = json?.delta?.message?.content?.text;
        if (typeof delta === "string" && delta.length > 0) {
          fullText += delta;
          if (firstChunkMs === null) firstChunkMs = Date.now() - startedAt;
          onDelta?.(delta);
        }
      } else if (json?.type === "message-end") {
        finalUsage = json?.delta?.usage?.tokens ?? null;
      }
    }
  }

  if (!fullText) {
    throw new ProviderError("Cohere streamed response was empty", response.status, "cohere", "No content-delta events received");
  }

  const usage = {
    promptTokens: finalUsage?.input_tokens ?? 0,
    completionTokens: finalUsage?.output_tokens ?? 0,
  };

  return normalizeSuccess(fullText, "cohere", model, usage, { firstChunkMs, streamed: true });
}
