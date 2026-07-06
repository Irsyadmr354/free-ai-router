/**
 * index.js
 * MCP server entry point for free-ai-router (enhanced edition).
 *
 * Registered tools:
 *   1. chat_completion   — sequential fallback across all configured providers
 *   2. list_providers    — status, cooldown, and model list for every provider
 *   3. embed_text        — embedding vectors via Gemini or OpenRouter
 *   4. count_tokens      — rough token estimate before sending a prompt
 *   5. ping_providers    — live health check (short test prompt to each provider)
 *   6. get_usage_stats   — session token/call counts + log file path
 */

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Providers
import { callGemini, embedGemini, SUPPORTED_MODELS as GEMINI_MODELS, DEFAULT_MODEL as GEMINI_DEFAULT } from "./providers/gemini.js";
import { callGroq, SUPPORTED_MODELS as GROQ_MODELS, DEFAULT_MODEL as GROQ_DEFAULT } from "./providers/groq.js";
import { callOpenRouter, embedOpenRouter, SUPPORTED_MODELS as OR_MODELS, DEFAULT_MODEL as OR_DEFAULT } from "./providers/openrouter.js";
import { callCloudflare, SUPPORTED_MODELS as CF_MODELS, DEFAULT_MODEL as CF_DEFAULT } from "./providers/cloudflare.js";
import { callSambaNova, SUPPORTED_MODELS as SAMBANOVA_MODELS, DEFAULT_MODEL as SAMBANOVA_DEFAULT } from "./providers/sambanova.js";
import { callCohere, SUPPORTED_MODELS as COHERE_MODELS, DEFAULT_MODEL as COHERE_DEFAULT } from "./providers/cohere.js";
import { callMistral, SUPPORTED_MODELS as MISTRAL_MODELS, DEFAULT_MODEL as MISTRAL_DEFAULT } from "./providers/mistral.js";

// Lib
import { ProviderError } from "./lib/normalize.js";
import { log, logError } from "./lib/logger.js";
import { markCooldown, isOnCooldown, cooldownRemainingSeconds, allCooldowns, clearCooldown } from "./lib/cooldown.js";
import { buildKey, cacheGet, cacheSet, cacheStats } from "./lib/cache.js";
import { recordUsage, getSessionStats } from "./lib/usage-tracker.js";
import { getProviderOrder, getApiKeys, ALL_PROVIDERS } from "./lib/config.js";

// ---------------------------------------------------------------------------
// Provider registry — maps name → call function + metadata
// ---------------------------------------------------------------------------

const PROVIDER_REGISTRY = {
  gemini:      { fn: callGemini,      models: GEMINI_MODELS,  defaultModel: GEMINI_DEFAULT  },
  groq:        { fn: callGroq,        models: GROQ_MODELS,    defaultModel: GROQ_DEFAULT    },
  openrouter:  { fn: callOpenRouter,  models: OR_MODELS,      defaultModel: OR_DEFAULT      },
  cloudflare:  { fn: callCloudflare,  models: CF_MODELS,      defaultModel: CF_DEFAULT      },
  sambanova:  { fn: callSambaNova,  models: SAMBANOVA_MODELS, defaultModel: SAMBANOVA_DEFAULT },
  cohere:      { fn: callCohere,      models: COHERE_MODELS,  defaultModel: COHERE_DEFAULT  },
  mistral:     { fn: callMistral,     models: MISTRAL_MODELS, defaultModel: MISTRAL_DEFAULT },
};

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "free-ai-router", version: "2.0.0" });

// ---------------------------------------------------------------------------
// Tool 1: chat_completion
// ---------------------------------------------------------------------------

server.tool(
  "chat_completion",
  "Send a prompt to a free-tier LLM. Automatically tries providers in order (default: Gemini → Groq → OpenRouter → Cloudflare → Together → Cohere → Mistral), skipping any provider currently on rate-limit cooldown. Returns which provider/model actually served the request. Use this instead of assuming API costs when the user wants free inference.",
  {
    prompt:        z.string().describe("The user message / prompt to send."),
    system_prompt: z.string().optional().describe("Optional system prompt."),
    max_tokens:    z.number().optional().default(1024).describe("Max tokens to generate. Default 1024."),
    temperature:   z.number().optional().default(0.7).describe("Sampling temperature 0–2. Default 0.7."),
    model:         z.string().optional().describe("Override the model for every provider that supports it. If not set, each provider uses its default free model."),
    providers:     z.array(z.string()).optional().describe("Restrict which providers to try, in order. E.g. [\"groq\",\"gemini\"]. Defaults to PROVIDER_ORDER env var or all providers."),
  },
  async ({ prompt, system_prompt, max_tokens = 1024, temperature = 0.7, model, providers }) => {
    const keys = getApiKeys();
    const order = providers?.length ? providers : getProviderOrder();
    const params = { prompt, systemPrompt: system_prompt, maxTokens: max_tokens, temperature };

    // Check cache first
    const cacheKey = buildKey({ order, model, prompt, system_prompt, max_tokens, temperature });
    const cached = cacheGet(cacheKey);
    if (cached) {
      log(`Cache hit — skipping all providers`);
      return {
        content: [{
          type: "text",
          text: `[served by: cache (originally: ${cached.provider}/${cached.model})]\n\n${cached.text}`,
        }],
      };
    }

    const errors = {};

    for (const providerName of order) {
      const entry = PROVIDER_REGISTRY[providerName];
      if (!entry) {
        logError(`Unknown provider "${providerName}" in order list — skipping`);
        continue;
      }

      const apiKey = keys[providerName];
      if (!apiKey) {
        log(`Skipping ${providerName} — no API key configured`);
        errors[providerName] = "No API key configured";
        continue;
      }

      if (isOnCooldown(providerName)) {
        const secs = cooldownRemainingSeconds(providerName);
        log(`Skipping ${providerName} — on cooldown for ${secs}s more`);
        errors[providerName] = `On rate-limit cooldown for ${secs}s`;
        continue;
      }

      const chosenModel = model ?? entry.defaultModel;
      log(`Trying ${providerName} (${chosenModel})…`);

      try {
        const result = await entry.fn({ ...params, model: chosenModel, apiKey });
        clearCooldown(providerName);
        log(`Success via ${providerName} (${result.model})`);
        recordUsage(result.provider, result.model, result.usage.promptTokens, result.usage.completionTokens);
        cacheSet(cacheKey, result);
        return {
          content: [{
            type: "text",
            text: `[served by: ${result.provider}/${result.model}]\n\n${result.text}`,
          }],
        };
      } catch (err) {
        const reason = buildReason(err);
        errors[providerName] = reason;
        if (err instanceof ProviderError && err.status === 429) {
          markCooldown(providerName);
          log(`${providerName} rate-limited (429) — cooldown started, trying next provider`);
        } else {
          logError(`${providerName} failed — ${reason} — trying next provider`);
        }
      }
    }

    // All providers failed
    const errorSummary = Object.entries(errors)
      .map(([p, r]) => `${p}: ${r}`)
      .join(". ");
    throw new Error(`All providers failed. ${errorSummary}.`);
  }
);

// ---------------------------------------------------------------------------
// Tool 2: list_providers
// ---------------------------------------------------------------------------

server.tool(
  "list_providers",
  "List all configured providers with their status (active / no-key / on-cooldown), cooldown remaining, and available models.",
  {},
  async () => {
    const keys = getApiKeys();
    const order = getProviderOrder();
    const cooldowns = allCooldowns();
    const cooldownMap = Object.fromEntries(cooldowns.map((c) => [c.provider, c.remainingSeconds]));

    const rows = order.map((name) => {
      const entry = PROVIDER_REGISTRY[name];
      const hasKey = Boolean(keys[name]);
      const remaining = cooldownMap[name] ?? 0;
      const status = !hasKey ? "no-key" : remaining > 0 ? `cooldown (${remaining}s)` : "active";
      return {
        provider: name,
        status,
        defaultModel: entry?.defaultModel ?? "—",
        supportedModels: entry?.models ?? [],
      };
    });

    const lines = rows.map((r) =>
      `• ${r.provider} [${r.status}]\n  default: ${r.defaultModel}\n  models: ${r.supportedModels.join(", ")}`
    );

    return {
      content: [{
        type: "text",
        text: `Provider order: ${order.join(" → ")}\n\n${lines.join("\n\n")}`,
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool 3: embed_text
// ---------------------------------------------------------------------------

server.tool(
  "embed_text",
  "Generate an embedding vector for the given text. Tries Gemini (text-embedding-004) first, then OpenRouter. Returns the vector as a JSON array.",
  {
    text:     z.string().describe("The text to embed."),
    provider: z.enum(["gemini", "openrouter"]).optional().default("gemini").describe("Which provider to use for embeddings."),
    model:    z.string().optional().describe("Override the embedding model."),
  },
  async ({ text, provider = "gemini", model }) => {
    const keys = getApiKeys();
    const apiKey = keys[provider];

    if (!apiKey) {
      throw new Error(`No API key configured for embedding provider "${provider}". Set ${provider.toUpperCase()}_API_KEY in .env.`);
    }

    let result;
    try {
      if (provider === "gemini") {
        result = await embedGemini({ text, model, apiKey });
      } else {
        result = await embedOpenRouter({ text, model, apiKey });
      }
    } catch (err) {
      throw new Error(`Embedding failed via ${provider}: ${buildReason(err)}`);
    }

    return {
      content: [{
        type: "text",
        text: `[embedding by: ${result.provider}/${result.model}]\ndimensions: ${result.embedding.length}\n\n${JSON.stringify(result.embedding)}`,
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool 4: count_tokens
// ---------------------------------------------------------------------------

server.tool(
  "count_tokens",
  "Estimate the token count for a prompt + optional system prompt before sending it. Uses a simple word-based approximation (~1.3 tokens/word). No API call is made.",
  {
    prompt:        z.string().describe("The prompt text to estimate."),
    system_prompt: z.string().optional().describe("Optional system prompt to include in the count."),
  },
  async ({ prompt, system_prompt }) => {
    const combined = [system_prompt, prompt].filter(Boolean).join("\n");
    const wordCount = combined.split(/\s+/).filter(Boolean).length;
    const charCount = combined.length;
    // Rough approximation: 1 token ≈ 4 chars (GPT-style), or ~1.3 tokens/word
    const estimateByWords = Math.ceil(wordCount * 1.3);
    const estimateByChars = Math.ceil(charCount / 4);
    const estimate = Math.round((estimateByWords + estimateByChars) / 2);

    return {
      content: [{
        type: "text",
        text: [
          `Estimated token count: ~${estimate}`,
          `  Words: ${wordCount}`,
          `  Characters: ${charCount}`,
          `  Method: average of word-based (~${estimateByWords}) and char-based (~${estimateByChars}) estimates`,
          ``,
          `Note: this is a rough estimate. Actual count varies by model tokenizer.`,
        ].join("\n"),
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool 5: ping_providers
// ---------------------------------------------------------------------------

server.tool(
  "ping_providers",
  "Health-check all providers that have an API key configured. Sends a minimal prompt ('Hi') to each and reports latency, success/failure, and which model responded. Useful for debugging before a real call.",
  {
    providers: z.array(z.string()).optional().describe("Subset of providers to ping. Defaults to all configured ones."),
  },
  async ({ providers }) => {
    const keys = getApiKeys();
    const order = providers?.length ? providers : getProviderOrder();
    const results = [];

    for (const name of order) {
      const entry = PROVIDER_REGISTRY[name];
      const apiKey = keys[name];

      if (!apiKey) {
        results.push({ provider: name, status: "skipped", reason: "no API key" });
        continue;
      }
      if (!entry) {
        results.push({ provider: name, status: "skipped", reason: "unknown provider" });
        continue;
      }

      const start = Date.now();
      try {
        const result = await entry.fn({
          prompt: "Hi",
          systemPrompt: undefined,
          maxTokens: 10,
          temperature: 0.1,
          model: entry.defaultModel,
          apiKey,
        });
        const ms = Date.now() - start;
        clearCooldown(name);
        results.push({ provider: name, status: "ok", model: result.model, latencyMs: ms, response: result.text.slice(0, 80) });
      } catch (err) {
        const ms = Date.now() - start;
        if (err instanceof ProviderError && err.status === 429) markCooldown(name);
        results.push({ provider: name, status: "error", latencyMs: ms, reason: buildReason(err) });
      }
    }

    const lines = results.map((r) => {
      if (r.status === "ok") {
        return `✅ ${r.provider} (${r.model}) — ${r.latencyMs}ms\n   "${r.response}"`;
      } else if (r.status === "error") {
        return `❌ ${r.provider} — ${r.latencyMs}ms — ${r.reason}`;
      } else {
        return `⏭  ${r.provider} — ${r.reason}`;
      }
    });

    return {
      content: [{
        type: "text",
        text: `Ping results:\n\n${lines.join("\n\n")}`,
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool 6: get_usage_stats
// ---------------------------------------------------------------------------

server.tool(
  "get_usage_stats",
  "Show token usage and call counts for this session, broken down by provider. Also shows cache stats and the path to the persistent usage log file.",
  {},
  async () => {
    const stats = getSessionStats();
    const cache = cacheStats();

    const sessionLines = stats.length
      ? stats.map((s) =>
          `• ${s.provider}: ${s.calls} call(s), ${s.promptTokens} prompt tokens, ${s.completionTokens} completion tokens (${s.totalTokens} total)`
        )
      : ["  (no calls made this session yet)"];

    return {
      content: [{
        type: "text",
        text: [
          "=== Session usage ===",
          ...sessionLines,
          "",
          "=== Response cache ===",
          `  Enabled: ${cache.enabled}`,
          `  Entries: ${cache.size}`,
          `  TTL: ${cache.ttlSeconds}s`,
          "",
          `=== Persistent log ===`,
          `  Path: ${process.env.USAGE_LOG_PATH ?? "./usage-log.jsonl"}`,
          `  Enabled: ${process.env.USAGE_TRACKING !== "false"}`,
        ].join("\n"),
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildReason(err) {
  if (err instanceof ProviderError) {
    const statusPart = err.status !== null ? ` (HTTP ${err.status})` : " (network/timeout)";
    const rawPart = err.rawMessage ? `: ${err.rawMessage.slice(0, 200)}` : "";
    return `${err.message}${statusPart}${rawPart}`;
  }
  return String(err?.message ?? err);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
log("MCP server v2.0.0 started on stdio transport");
log(`Provider order: ${getProviderOrder().join(" → ")}`);
