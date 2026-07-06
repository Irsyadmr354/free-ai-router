/**
 * lib/sse.js
 * Shared helper for consuming OpenAI-compatible Server-Sent Events (SSE)
 * streams (`data: {...}\n\n`, terminated by `data: [DONE]`).
 *
 * Used by providers whose streaming chat completion API follows the
 * OpenAI wire format: Groq, OpenRouter, Mistral, SambaNova.
 */

/**
 * Consume an SSE response body, calling onChunk(deltaText) for every
 * incremental content delta and onFirstChunk() exactly once when the
 * first non-empty delta arrives.
 *
 * @param {Response} response - a fetch() Response with a readable body
 * @param {(delta: string) => void} onChunk
 * @param {() => void} onFirstChunk
 * @returns {Promise<{ fullText: string, finalUsage: object|null, finalModel: string|null }>}
 */
export async function consumeOpenAiSse(response, onChunk, onFirstChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  let finalUsage = null;
  let finalModel = null;
  let firstChunkFired = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete line for next read

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // malformed/partial line, skip
      }

      const delta = json?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        fullText += delta;
        if (!firstChunkFired) {
          firstChunkFired = true;
          onFirstChunk();
        }
        onChunk(delta);
      }

      if (json?.model) finalModel = json.model;
      if (json?.usage) finalUsage = json.usage;
    }
  }

  return { fullText, finalUsage, finalModel };
}
