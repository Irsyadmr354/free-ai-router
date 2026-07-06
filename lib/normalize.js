/**
 * lib/normalize.js
 * Shared response/error shape helpers for all provider modules.
 */

/**
 * Returns a normalized success payload.
 * @param {string} text - The generated text from the provider.
 * @param {string} provider - Provider name (e.g. "gemini").
 * @param {string} model - Model identifier used.
 * @param {{ promptTokens?: number, completionTokens?: number }} [usage]
 * @param {{ firstChunkMs?: number|null, streamed?: boolean }} [timing]
 * @returns {{ text: string, provider: string, model: string, usage: { promptTokens: number, completionTokens: number }, timing: { firstChunkMs: number|null, streamed: boolean } }}
 */
export function normalizeSuccess(text, provider, model, usage = {}, timing = {}) {
  return {
    text,
    provider,
    model,
    usage: {
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
    },
    timing: {
      // ms elapsed between request start and first byte/chunk received.
      // null when the call wasn't made in streaming mode.
      firstChunkMs: timing.firstChunkMs ?? null,
      streamed: timing.streamed ?? false,
    },
  };
}

/**
 * Returns a normalized embedding payload.
 * @param {number[]} embedding
 * @param {string} provider
 * @param {string} model
 * @returns {{ embedding: number[], provider: string, model: string }}
 */
export function normalizeEmbedding(embedding, provider, model) {
  return { embedding, provider, model };
}

/**
 * Custom error class for provider-level failures.
 * Lets the orchestrator distinguish rate-limit errors (429)
 * from auth failures (401/403), server errors (5xx), and
 * network/timeout errors (status = null).
 */
export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {number|null} status
   * @param {string} provider
   * @param {string} rawMessage
   */
  constructor(message, status, provider, rawMessage) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.provider = provider;
    this.rawMessage = rawMessage;
  }
}
