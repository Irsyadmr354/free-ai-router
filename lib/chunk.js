/**
 * lib/chunk.js
 * Splits a long `context` document into token-budget-sized chunks so it can
 * be summarized/analyzed piece by piece by chat_completion, staying under
 * each provider's effective context window.
 *
 * Uses the same rough word/char hybrid estimate as count_tokens for
 * consistency — no tokenizer dependency.
 */

function estimateTokens(text) {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const charCount = text.length;
  const estimateByWords = Math.ceil(wordCount * 1.3);
  const estimateByChars = Math.ceil(charCount / 4);
  return Math.round((estimateByWords + estimateByChars) / 2);
}

/**
 * Split `context` into chunks that each stay under `maxTokensPerChunk`,
 * splitting on paragraph boundaries first, then sentence boundaries, then
 * hard character cuts as a last resort so no chunk ever exceeds the budget.
 * @param {string} context
 * @param {number} maxTokensPerChunk
 * @returns {string[]}
 */
export function chunkContext(context, maxTokensPerChunk = 3000) {
  if (!context) return [];
  if (estimateTokens(context) <= maxTokensPerChunk) return [context];

  const paragraphs = context.split(/\n{2,}/);
  const chunks = [];
  let current = "";

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (estimateTokens(candidate) <= maxTokensPerChunk) {
      current = candidate;
      continue;
    }

    // Current paragraph alone doesn't fit with what's accumulated — flush and retry.
    flush();

    if (estimateTokens(para) <= maxTokensPerChunk) {
      current = para;
      continue;
    }

    // Paragraph itself is too big — split by sentence.
    const sentences = para.split(/(?<=[.!?])\s+/);
    let sentenceBuf = "";
    for (const sentence of sentences) {
      const sCandidate = sentenceBuf ? `${sentenceBuf} ${sentence}` : sentence;
      if (estimateTokens(sCandidate) <= maxTokensPerChunk) {
        sentenceBuf = sCandidate;
      } else {
        if (sentenceBuf.trim()) chunks.push(sentenceBuf.trim());
        // Sentence itself too big (rare) — hard cut by characters.
        if (estimateTokens(sentence) > maxTokensPerChunk) {
          const approxCharsPerChunk = maxTokensPerChunk * 4;
          for (let i = 0; i < sentence.length; i += approxCharsPerChunk) {
            chunks.push(sentence.slice(i, i + approxCharsPerChunk));
          }
          sentenceBuf = "";
        } else {
          sentenceBuf = sentence;
        }
      }
    }
    if (sentenceBuf.trim()) chunks.push(sentenceBuf.trim());
  }

  flush();
  return chunks;
}

export { estimateTokens };
