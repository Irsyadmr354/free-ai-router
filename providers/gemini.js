/**
 * providers/gemini.js
 * Calls the Google Gemini API and returns a normalized response.
 *
 * Supported free-tier models (default first):
 *   gemini-2.5-flash, gemini-2.0-flash, gemini-1.5-flash, gemini-1.5-flash-8b
 */

import { normalizeSuccess, normalizeEmbedding, ProviderError } from "../lib/normalize.js";
import { getTimeout } from "../lib/config.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
export const DEFAULT_MODEL = "gemini-2.5-flash";
export const DEFAULT_EMBED_MODEL = "text-embedding-004";

export const SUPPORTED_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
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
export async function callGemini({ prompt, systemPrompt, maxTokens, temperature, model = DEFAULT_MODEL, apiKey, imageUrl, imageBase64, imageMimeType, tools, responseFormat }) {
  const url = `${BASE}/${model}:generateContent?key=${apiKey}`;

  const parts = [{ text: prompt }];

  if (imageBase64) {
    parts.push({
      inlineData: {
        mimeType: imageMimeType || "image/jpeg",
        data: imageBase64,
      },
    });
  } else if (imageUrl) {
    // Gemini needs raw bytes, not a URL — fetch and inline as base64.
    const fetched = await fetchImageAsBase64(imageUrl);
    parts.push({ inlineData: { mimeType: fetched.mimeType, data: fetched.data } });
  }

  const generationConfig = { maxOutputTokens: maxTokens, temperature };
  if (responseFormat === "json") {
    generationConfig.responseMimeType = "application/json";
  }

  const body = {
    contents: [{ parts }],
    generationConfig,
  };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };

  // Gemini expects OpenAI-style tool schemas translated into functionDeclarations.
  if (tools?.length) {
    body.tools = [{
      functionDeclarations: tools.map((t) => ({
        name: t.function?.name ?? t.name,
        description: t.function?.description ?? t.description,
        parameters: t.function?.parameters ?? t.parameters,
      })),
    }];
  }

  const response = await doFetch("gemini", url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  const candidateParts = data?.candidates?.[0]?.content?.parts ?? [];
  const text = candidateParts.find((p) => typeof p.text === "string")?.text;
  const functionCalls = candidateParts.filter((p) => p.functionCall).map((p) => p.functionCall);

  if (typeof text !== "string" && !functionCalls.length) {
    throw new ProviderError("Gemini response missing expected text field", response.status, "gemini", JSON.stringify(data).slice(0, 500));
  }

  const usage = {
    promptTokens: data?.usageMetadata?.promptTokenCount ?? 0,
    completionTokens: data?.usageMetadata?.candidatesTokenCount ?? 0,
  };

  const result = normalizeSuccess(text ?? "", "gemini", model, usage);
  if (functionCalls.length) result.toolCalls = functionCalls;
  return result;
}

/**
 * Real streaming variant — forwards each text delta to onDelta(text) as it
 * arrives from Gemini's streamGenerateContent?alt=sse endpoint, instead of
 * collecting the full text before returning. Gemini does NOT use the
 * OpenAI-style delta format — it's newline-delimited SSE where each event
 * payload is a full candidates[] object; the incremental text is
 * candidates[0].content.parts[0].text on each event.
 *
 * @param {object} p - same shape as callGemini(), plus:
 * @param {(text: string) => void} p.onDelta - called per content delta
 * @param {AbortSignal} [p.abortSignal] - external abort (e.g. client disconnect)
 */
export async function streamGemini({ prompt, systemPrompt, maxTokens, temperature, model = DEFAULT_MODEL, apiKey, imageUrl, imageBase64, imageMimeType, tools, responseFormat, onDelta, abortSignal }) {
  const url = `${BASE}/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const parts = [{ text: prompt }];

  if (imageBase64) {
    parts.push({
      inlineData: {
        mimeType: imageMimeType || "image/jpeg",
        data: imageBase64,
      },
    });
  } else if (imageUrl) {
    const fetched = await fetchImageAsBase64(imageUrl);
    parts.push({ inlineData: { mimeType: fetched.mimeType, data: fetched.data } });
  }

  const generationConfig = { maxOutputTokens: maxTokens, temperature };
  if (responseFormat === "json") {
    generationConfig.responseMimeType = "application/json";
  }

  const body = {
    contents: [{ parts }],
    generationConfig,
  };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };

  if (tools?.length) {
    body.tools = [{
      functionDeclarations: tools.map((t) => ({
        name: t.function?.name ?? t.name,
        description: t.function?.description ?? t.description,
        parameters: t.function?.parameters ?? t.parameters,
      })),
    }];
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeout("gemini"));
  if (abortSignal) abortSignal.addEventListener("abort", () => controller.abort(), { once: true });

  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err.name === "AbortError" ? "Request timed out after " + getTimeout("gemini") + "ms" : String(err.message);
    throw new ProviderError(`Gemini network/timeout error: ${msg}`, null, "gemini", msg);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const bodyText = (await response.text().catch(() => "")).slice(0, 500);
    throw new ProviderError(`Gemini returned HTTP ${response.status}`, response.status, "gemini", bodyText);
  }

  let firstChunkMs = null;
  let fullText = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let functionCalls = [];

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
        continue; // malformed/partial line, skip
      }

      const candidateParts = json?.candidates?.[0]?.content?.parts ?? [];
      const textPart = candidateParts.find((p) => typeof p.text === "string");
      if (textPart?.text) {
        fullText += textPart.text;
        if (firstChunkMs === null) firstChunkMs = Date.now() - startedAt;
        onDelta?.(textPart.text);
      }
      const fcParts = candidateParts.filter((p) => p.functionCall).map((p) => p.functionCall);
      if (fcParts.length) functionCalls.push(...fcParts);

      if (json?.usageMetadata) {
        promptTokens = json.usageMetadata.promptTokenCount ?? promptTokens;
        completionTokens = json.usageMetadata.candidatesTokenCount ?? completionTokens;
      }
    }
  }

  if (!fullText && !functionCalls.length) {
    throw new ProviderError("Gemini streamed response was empty", response.status, "gemini", "No text parts received");
  }

  const usage = { promptTokens, completionTokens };
  const result = normalizeSuccess(fullText, "gemini", model, usage, { firstChunkMs, streamed: true });
  if (functionCalls.length) result.toolCalls = functionCalls;
  return result;
}

/**
 * Generate an embedding vector.
 * @param {object} p
 * @param {string} p.text
 * @param {string} [p.model]
 * @param {string} p.apiKey
 */
export async function embedGemini({ text, model = DEFAULT_EMBED_MODEL, apiKey }) {
  const url = `${BASE}/${model}:embedContent?key=${apiKey}`;
  const body = { model: `models/${model}`, content: { parts: [{ text }] } };

  const response = await doFetch("gemini", url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  const embedding = data?.embedding?.values;
  if (!Array.isArray(embedding)) {
    throw new ProviderError("Gemini embed response missing values", response.status, "gemini", JSON.stringify(data).slice(0, 500));
  }
  return normalizeEmbedding(embedding, "gemini", model);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fetch an image from a URL and return it as base64 + mime type, ready to
 * inline into a Gemini request. Gemini's REST API does not accept remote
 * image URLs directly — only inline base64 bytes.
 * @param {string} url
 * @returns {Promise<{ data: string, mimeType: string }>}
 */
async function fetchImageAsBase64(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new ProviderError(`Failed to fetch image_url: ${err.message}`, null, "gemini", err.message);
  }
  if (!res.ok) {
    throw new ProviderError(`image_url returned HTTP ${res.status}`, res.status, "gemini", `Could not download image from ${url}`);
  }
  const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  return { data: buf.toString("base64"), mimeType };
}

async function doFetch(provider, url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeout(provider));

  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err.name === "AbortError" ? "Request timed out after " + getTimeout(provider) + "ms" : String(err.message);
    throw new ProviderError(`Gemini network/timeout error: ${msg}`, null, "gemini", msg);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const bodyText = (await response.text().catch(() => "")).slice(0, 500);
    throw new ProviderError(`Gemini returned HTTP ${response.status}`, response.status, "gemini", bodyText);
  }

  return response;
}
