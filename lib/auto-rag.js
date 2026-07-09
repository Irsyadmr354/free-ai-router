import { pipeline, env } from '@xenova/transformers';
import { log, logError } from "./logger.js";

// Ensure local caching is preferred
env.allowLocalModels = true;

let extractor = null;

async function getExtractor() {
  if (!extractor) {
    log("[auto-rag] Loading embedding model (Xenova/all-MiniLM-L6-v2)...");
    extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return extractor;
}

function chunkText(text, maxChars) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let currentChunk = "";
  for (const s of sentences) {
    if ((currentChunk.length + s.length) > maxChars && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = "";
    }
    currentChunk += s + " ";
  }
  if (currentChunk.trim()) chunks.push(currentChunk.trim());
  return chunks;
}

function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Applies Local Auto-RAG using transformers.js
 * If prompt > AUTO_RAG_THRESHOLD tokens, chunk and embed locally.
 */
export async function applyAutoRag(params) {
  const threshold = parseInt(process.env.AUTO_RAG_THRESHOLD || "20000", 10);
  
  // Rough estimate: 1 token ~= 4 chars
  const promptChars = params.prompt?.length || 0;
  const promptTokenEst = promptChars / 4;
  
  if (promptTokenEst < threshold) {
    return params;
  }

  log(`[auto-rag] Prompt is ~${Math.round(promptTokenEst)} tokens. Engaging Local Auto-RAG...`);
  
  // Find query from messages
  let query = "";
  if (params.messages && params.messages.length > 0) {
    const lastUser = [...params.messages].reverse().find(m => m.role === "user");
    if (lastUser) query = lastUser.content;
  }
  if (!query) {
    log("[auto-rag] No user query found to anchor RAG search. Skipping.");
    return params;
  }

  try {
    const chunks = chunkText(params.prompt, 2000); 
    const extract = await getExtractor();
    
    // Embed query
    const queryOutput = await extract(query, { pooling: 'mean', normalize: true });
    const queryEmbedding = Array.from(queryOutput.data);

    // Embed chunks
    const chunkScores = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkOutput = await extract(chunks[i], { pooling: 'mean', normalize: true });
      const chunkEmbedding = Array.from(chunkOutput.data);
      const score = cosineSimilarity(queryEmbedding, chunkEmbedding);
      chunkScores.push({ text: chunks[i], score });
    }

    // Sort by score descending
    chunkScores.sort((a, b) => b.score - a.score);
    
    // Take top 5 chunks
    const topChunks = chunkScores.slice(0, 5); 
    
    const newPrompt = `[SYSTEM INSTRUCTION: The original context was extremely large. Below are the most relevant excerpts dynamically extracted to answer your specific query.]\n\n` + 
      topChunks.map(c => `--- Excerpt (Relevance: ${(c.score * 100).toFixed(1)}%) ---\n${c.text}`).join("\n\n");
    
    log(`[auto-rag] Compressed ${promptChars} chars down to ${newPrompt.length} chars.`);

    return {
      ...params,
      prompt: newPrompt
    };
  } catch (err) {
    logError(`[auto-rag] Failed to execute RAG: ${err.message}. Bypassing.`);
    return params;
  }
}
