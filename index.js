#!/usr/bin/env node
/**
 * index.js
 * MCP server entry point for free-ai-router (v4.0.0).
 *
 * See ROADMAP.md for the full feature backlog this version implements
 * (Batches 2-6). Registered tools are listed below; grep for "Tool N:" to
 * jump to each handler.
 *
 *   1.  chat_completion        — sequential fallback across all configured providers
 *   2.  list_providers         — status, cooldown, reputation, and model list for every provider
 *   3.  embed_text             — embedding vectors via Gemini or OpenRouter
 *   4.  count_tokens           — rough token estimate before sending a prompt
 *   5.  ping_providers         — live health check (short test prompt to each provider)
 *   6.  get_usage_stats        — session token/call counts + log file path + budget usage
 *   7.  set_provider_order     — dynamically change fallback order at runtime
 *   8.  clear_cache            — manually flush the in-memory response cache
 *   9.  compare_providers      — send the same prompt to every provider, compare side-by-side
 *   10. get_benchmarks         — average/p95 latency + success rate per provider
 *   11. chat_with_template     — run a prompt template from ./templates/*.md
 *   12. summarize_usage_log    — aggregate usage-log.jsonl by day/week/provider
 *   13. export_usage_report    — generate a Markdown or CSV usage report file
 *   14. translate              — wrapper tool: translate text
 *   15. summarize              — wrapper tool: summarize text
 *   16. code_review            — wrapper tool: review code
 *   17. get_reputation         — provider reputation scores (Batch 6 flagship)
 *
 * v4.0.0 changes (Batches 2-6):
 *   - chat_completion: streaming param wired through (reports time-to-first-chunk),
 *     tool calling / function calling passthrough, response_format json mode,
 *     per-provider max_tokens cap enforcement, budget-aware + reputation-aware +
 *     benchmark-aware provider reordering, provider aliases, input sanitization,
 *     system-prompt injection per provider, multi-language system prompt,
 *     response quality scoring with soft-fail retry, smart retry on network
 *     errors, request deduplication, long-context auto-chunking via `context`
 *     param, session_id tracking, verbose fallback-reason transparency,
 *     SIMULATE_FAILURES test hook.
 *   - New tools: compare_providers, get_benchmarks, chat_with_template,
 *     summarize_usage_log, export_usage_report, translate, summarize,
 *     code_review, get_reputation.
 *   - New: web dashboard (DASHBOARD_ENABLED=true), MCP Resources for
 *     usage-log.jsonl and cooldown-state.json, OpenTelemetry-style tracing
 *     (TRACING_ENABLED=true), provider warm-up pool (PROVIDER_WARMUP_ENABLED=true),
 *     config validation warnings logged at startup.
 */

import "dotenv/config";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Providers (embeddings only — chat completion call*() functions now come
// from lib/router-core.js, shared with http-server.js)
import { embedGemini } from "./providers/gemini.js";
import { embedOpenRouter } from "./providers/openrouter.js";

// Shared provider registry + fallback chain (extracted so index.js and
// http-server.js don't duplicate this logic in two places)
import { PROVIDER_REGISTRY, reorderProviders, executeProviderChain as sharedExecuteProviderChain, buildReason as sharedBuildReason } from "./lib/router-core.js";

// Lib — core
import { ProviderError } from "./lib/normalize.js";
import { log, logError } from "./lib/logger.js";
import { markCooldown, isOnCooldown, cooldownRemainingSeconds, allCooldowns, clearCooldown } from "./lib/cooldown.js";
import { buildKey, cacheGet, cacheSet, cacheStats, cacheClear } from "./lib/cache.js";
import { recordUsage, getSessionStats } from "./lib/usage-tracker.js";
import {
  getProviderOrder, getApiKeys, ALL_PROVIDERS, isModelFallbackEnabled,
  getMaxTokensCap, getBudget, getBudgetDeprioritizeThreshold,
  getProviderAliases, resolveProviderAliases, getSanitizationConfig,
  isQualityScoringEnabled, isMultiLanguagePromptEnabled, getSystemInjections,
  getSimulatedFailures, validateConfig,
} from "./lib/config.js";
import { notifyAllProvidersFailed } from "./lib/notifier.js";

// Lib — new (Batches 2-6)
import { recordBudgetUsage, getAllBudgetUsage, deprioritizeNearLimitProviders } from "./lib/budget-tracker.js";
import { sanitizePrompt } from "./lib/sanitize.js";
import { scoreResponseQuality } from "./lib/quality-score.js";
import { detectLanguageHint } from "./lib/lang-detect.js";
import { dedupe } from "./lib/dedup.js";
import { chunkContext } from "./lib/chunk.js";
import { recordBenchmark, getAllBenchmarks, sortByBenchmark } from "./lib/benchmark.js";
import { updateReputation, sortByReputation, getReputationSnapshot } from "./lib/reputation.js";
import { listTemplates, loadTemplate, fillTemplate } from "./lib/templates.js";
import { summarizeUsage, buildMarkdownReport, buildCsvReport } from "./lib/report.js";
import { startWarmupPool } from "./lib/warmup.js";
import { startDashboard } from "./lib/dashboard.js";
import { startSpan, isTracingEnabled } from "./lib/tracing.js";

// ---------------------------------------------------------------------------
// Provider registry — now sourced from lib/router-core.js (shared with
// http-server.js) instead of being redefined here.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Runtime provider order (mutable via set_provider_order tool)
// ---------------------------------------------------------------------------
let runtimeProviderOrder = null; // null = use env/default

function getActiveProviderOrder() {
  return runtimeProviderOrder ?? getProviderOrder();
}

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "free-ai-router", version: "4.0.0" });

// ---------------------------------------------------------------------------
// Tool 1: chat_completion
// ---------------------------------------------------------------------------

server.tool(
  "chat_completion",
  "Send a prompt to a free-tier LLM. Automatically tries providers in order (default: Gemini → Groq → OpenRouter → Cloudflare → SambaNova → Cohere → Mistral), skipping any provider currently on rate-limit cooldown, near its known free-tier budget, or with low reputation. Within a single provider, if the chosen model fails with a retryable error, other models supported by that provider are tried before moving to the next provider. Supports image input (Gemini), tool/function calling, JSON mode, streaming timing, long-context auto-chunking, and prompt templates. Returns which provider/model actually served the request.",
  {
    prompt:        z.string().optional().describe("The user message / prompt to send. Required unless `messages` or `context` is provided."),
    system_prompt: z.string().optional().describe("Optional system prompt."),
    max_tokens:    z.number().int().min(1).max(8192).optional().default(1024).describe("Max tokens to generate (1–8192). Default 1024. Automatically clamped to each provider's own cap."),
    temperature:   z.number().min(0).max(2).optional().default(0.7).describe("Sampling temperature (0–2). Default 0.7."),
    model:         z.string().optional().describe("Override the model for every provider that supports it. Must be one of that provider's SUPPORTED_MODELS — invalid models are rejected rather than silently sent through. If not set, each provider uses its default free model."),
    providers:     z.array(z.string()).optional().describe("Restrict which providers to try, in order. Accepts provider names or configured aliases (see ALIAS_* env vars). E.g. [\"fast\",\"gemini\"]. Defaults to active provider order."),
    messages:      z.array(z.object({
                     role:    z.enum(["user", "assistant", "system"]),
                     content: z.string(),
                   })).optional().describe("Multi-turn conversation history. If provided, overrides prompt and system_prompt. Last message must be role=user."),
    context:       z.string().optional().describe("A long document/codebase to analyze alongside the prompt. Automatically chunked if it exceeds a safe per-request token budget; each chunk is processed sequentially and results are concatenated with chunk markers. Use for content too large to fit in one call."),
    no_cache:      z.boolean().optional().default(false).describe("If true, skip the response cache entirely for this call (both read and write)."),
    image_url:     z.string().url().optional().describe("URL of an image to analyze alongside the prompt. Only supported via the Gemini provider — the router will route this request to Gemini regardless of the configured provider order."),
    image_base64:  z.string().optional().describe("Base64-encoded image data (no data: prefix) to analyze alongside the prompt. Only supported via Gemini. Use image_mime_type to set the format."),
    image_mime_type: z.string().optional().default("image/jpeg").describe("MIME type of image_base64 (e.g. image/png, image/jpeg). Ignored for image_url."),
    stream:        z.boolean().optional().default(false).describe("Request the response as a stream from the provider (where supported: Groq, OpenRouter, Mistral, SambaNova, Cohere). The full text is still returned in one tool result (stdio can't push partial chunks to the caller), but time-to-first-chunk is measured and included when verbose=true."),
    tools:         z.array(z.object({}).passthrough()).optional().describe("OpenAI-style tool/function definitions to forward to providers that support tool calling (Groq, OpenRouter, Mistral, Gemini). If the model responds with tool calls instead of text, they are returned as-is for you to execute and continue the conversation."),
    tool_choice:   z.union([z.string(), z.object({}).passthrough()]).optional().describe("Forwarded to providers supporting tool_choice (e.g. \"auto\", \"none\", or a specific tool spec)."),
    response_format: z.enum(["text", "json"]).optional().default("text").describe("Set to \"json\" for structured JSON output on providers that support native JSON mode (Groq, OpenRouter, Gemini, Mistral)."),
    no_code:       z.boolean().optional().default(false).describe("If true, skip the response cache entirely for this call (alias of no_cache; kept for compatibility)."),
    session_id:    z.string().optional().describe("Optional session identifier. Included in the usage log so multiple calls belonging to the same conversation can be grouped when analyzing token usage."),
    verbose:       z.boolean().optional().default(false).describe("If true, append a footnote explaining which providers were skipped and why, and what timing/quality info was observed."),
  },
  async (args) => {
    return handleChatCompletion(args);
  }
);

async function handleChatCompletion({
  prompt, system_prompt, max_tokens = 1024, temperature = 0.7, model, providers, messages,
  context, no_cache = false, image_url, image_base64, image_mime_type = "image/jpeg",
  stream = false, tools, tool_choice, response_format = "text", session_id, verbose = false,
}) {
  const span = isTracingEnabled() ? startSpan("chat_completion", { session_id, model, response_format, stream }) : null;
  try {
    // Long-context handling: if `context` is provided and too large, chunk it
    // and process sequentially, concatenating results.
    if (context) {
      const chunks = chunkContext(context, 3000);
      if (chunks.length > 1) {
        const parts = [];
        for (let i = 0; i < chunks.length; i++) {
          const chunkPrompt = `${prompt ? prompt + "\n\n" : ""}[Context chunk ${i + 1}/${chunks.length}]\n${chunks[i]}`;
          const result = await handleChatCompletion({
            prompt: chunkPrompt, system_prompt, max_tokens, temperature, model, providers,
            no_cache, stream, tools, tool_choice, response_format, session_id, verbose: false,
          });
          parts.push(`--- chunk ${i + 1}/${chunks.length} ---\n${result.content[0].text}`);
        }
        return { content: [{ type: "text", text: parts.join("\n\n") }] };
      }
      // Single chunk fits — fold into prompt and continue normally.
      prompt = `${prompt ? prompt + "\n\n" : ""}${chunks[0] ?? context}`;
    }

    if (!prompt && !messages?.length) {
      throw new Error("Either `prompt`, `messages`, or `context` must be provided.");
    }

    const keys = getApiKeys();
    const hasImage = Boolean(image_url || image_base64);
    const simulatedFailures = getSimulatedFailures();

    // Resolve provider aliases (e.g. "fast" -> "groq") before anything else.
    let order = providers?.length ? resolveProviderAliases(providers) : getActiveProviderOrder();

    // Images are only supported by Gemini right now.
    if (hasImage) {
      if (!order.includes("gemini")) {
        throw new Error(`image_url/image_base64 is only supported via the Gemini provider, but "gemini" is not in the active provider list (${order.join(", ")}). Add it to providers, or configure GEMINI_API_KEY.`);
      }
      order = ["gemini"];
    } else {
      // Reorder by budget headroom, then benchmark, then reputation — cheap
      // heuristics stacked so a provider that's fast, reliable, AND has
      // budget headroom naturally floats to the top; providers restricted
      // via `providers` still only reorder among themselves.
      order = reorderProviders(order);
    }

    if (tools?.length && !hasImage) {
      const toolCapable = order.filter((p) => PROVIDER_REGISTRY[p]?.supportsTools);
      if (toolCapable.length) order = [...toolCapable, ...order.filter((p) => !toolCapable.includes(p))];
    }

    // Validate model against whitelist per provider.
    if (model) {
      const knownAnywhere = Object.values(PROVIDER_REGISTRY).some((e) => e.models.includes(model));
      if (!knownAnywhere) {
        const allModels = Object.entries(PROVIDER_REGISTRY)
          .map(([name, e]) => `${name}: ${e.models.join(", ")}`)
          .join("\n");
        throw new Error(`Unknown model "${model}". It doesn't match any provider's SUPPORTED_MODELS.\n\n${allModels}`);
      }
    }

    // Sanitize free-text inputs before they leave the process.
    let sanitizeNote = "";
    if (prompt) {
      const s = sanitizePrompt(prompt);
      prompt = s.text;
      if (s.truncated || s.redactions) {
        sanitizeNote = ` [sanitized: ${s.truncated ? "prompt truncated; " : ""}${s.redactions ? `${s.redactions} possible API key(s) redacted` : ""}]`.trim();
      }
    }

    // Multi-language system prompt: detect language of the user's prompt and
    // nudge the model to reply in kind, if enabled and no explicit system prompt override conflicts.
    if (isMultiLanguagePromptEnabled() && prompt) {
      const langHint = detectLanguageHint(prompt);
      if (langHint) {
        const nudge = `Respond in ${langHint}, matching the language of the user's message.`;
        system_prompt = system_prompt ? `${system_prompt}\n\n${nudge}` : nudge;
      }
    }

    // Build params — support both single-prompt and multi-turn modes
    let params;
    if (messages?.length) {
      const systemMsg = messages.find((m) => m.role === "system");
      const chatMessages = messages.filter((m) => m.role !== "system");
      params = {
        prompt: chatMessages.map((m) => `${m.role}: ${m.content}`).join("\n"),
        systemPrompt: systemMsg?.content ?? system_prompt,
        messages: chatMessages,
        maxTokens: max_tokens,
        temperature,
      };
    } else {
      params = {
        prompt,
        systemPrompt: system_prompt,
        maxTokens: max_tokens,
        temperature,
      };
    }

    if (hasImage) {
      params.imageUrl = image_url;
      params.imageBase64 = image_base64;
      params.imageMimeType = image_mime_type;
    }
    if (tools?.length) {
      params.tools = tools;
      if (tool_choice) params.toolChoice = tool_choice;
    }
    if (response_format === "json") {
      params.responseFormat = "json";
    }
    if (stream) {
      params.stream = true;
    }

    const cacheKey = buildKey({
      model,
      prompt: params.prompt,
      system_prompt: params.systemPrompt,
      max_tokens,
      temperature,
      image_url,
      image_base64,
    });

    const skipCache = no_cache || hasImage || Boolean(tools?.length);

    if (!skipCache) {
      const cached = cacheGet(cacheKey);
      if (cached) {
        log(`Cache hit — skipping all providers`);
        span?.end({ result: "cache-hit" });
        return {
          content: [{
            type: "text",
            text: `[served by: cache (originally: ${cached.provider}/${cached.model})]\n\n${cached.text}`,
          }],
        };
      }
    }

    // Request deduplication: identical concurrent calls share one in-flight promise.
    const runOnce = () => sharedExecuteProviderChain({
      order, keys, model, params, tools, tool_choice, response_format,
      hasImage, session_id, sanitizeNote, verbose,
    }).then((result) => formatMcpResult(result, { skipCache, cacheKey, verbose }));

    const result = skipCache ? await runOnce() : await dedupe(cacheKey, runOnce);
    span?.end({ result: "success" });
    return result;
  } catch (err) {
    span?.end({ result: "error", error: String(err?.message ?? err) });
    throw err;
  }
}

/**
 * Adapt a shared executeProviderChain() result (from lib/router-core.js)
 * into the MCP tool's { content: [{ type: "text", text }] } shape, and
 * write through to the response cache the same way the old inline
 * executeProviderChain used to.
 */
function formatMcpResult(result, { skipCache, cacheKey, verbose }) {
  if (!skipCache) cacheSet(cacheKey, result);

  const meta = result._meta ?? {};
  const fallbackNote = meta.fallbackModel ? ` (fallback model within ${result.provider}; ${meta.fallbackModel} failed first)` : "";
  const timingNote = result.timing?.streamed && result.timing?.firstChunkMs !== null
    ? ` (first chunk in ${result.timing.firstChunkMs}ms)`
    : "";

  let text = `[served by: ${result.provider}/${result.model}${fallbackNote}${timingNote}${meta.cappedNote ?? ""}${meta.sanitizeNote ?? ""}]\n\n`;
  if (result.toolCalls?.length) {
    text += `[tool calls requested]\n${JSON.stringify(result.toolCalls, null, 2)}\n\n${result.text ?? ""}`;
  } else {
    text += result.text;
  }

  if (verbose) {
    const skippedSummary = Object.entries(meta.skippedReasons ?? {}).map(([p, r]) => `${p}: ${r}`).join("; ");
    const errorSummary = Object.entries(meta.errors ?? {}).map(([p, r]) => `${p}: ${r}`).join("; ");
    text += `\n\n---\n[verbose] providers skipped: ${skippedSummary || "none"}. providers errored before success: ${errorSummary || "none"}.`;
  }

  return { content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// Tool 2: list_providers
// ---------------------------------------------------------------------------

server.tool(
  "list_providers",
  "List all configured providers with their status (active / no-key / on-cooldown), cooldown remaining, reputation score, budget usage, and available models.",
  {},
  async () => {
    const keys = getApiKeys();
    const order = getActiveProviderOrder();
    const cooldownList = allCooldowns();
    const cooldownMap = Object.fromEntries(cooldownList.map((c) => [c.provider, c.remainingSeconds]));
    const budgetUsage = Object.fromEntries(getAllBudgetUsage(order).map((b) => [b.provider, b]));
    const reputationSnapshot = Object.fromEntries(getReputationSnapshot(order).map((r) => [r.provider, r.reputation]));

    const rows = order.map((name) => {
      const entry = PROVIDER_REGISTRY[name];
      const hasKey = Boolean(keys[name]);
      const remaining = cooldownMap[name] ?? 0;
      const budget = budgetUsage[name];
      const status = !hasKey ? "no-key" : remaining > 0 ? `cooldown (${remaining}s)` : "active";
      return {
        provider: name,
        status,
        reputation: reputationSnapshot[name] ?? 70,
        budget: budget?.limit ? `${budget.count}/${budget.limit} per ${budget.window}${budget.nearLimit ? " (near limit!)" : ""}` : "unlimited/unknown",
        defaultModel: entry?.defaultModel ?? "—",
        supportedModels: entry?.models ?? [],
        supportsImages: entry?.supportsImages ?? false,
        supportsTools: entry?.supportsTools ?? false,
        supportsStream: entry?.supportsStream ?? false,
      };
    });

    const flags = (r) => [
      r.supportsImages ? "🖼️ images" : null,
      r.supportsTools ? "🔧 tools" : null,
      r.supportsStream ? "⏱ stream" : null,
    ].filter(Boolean).join(" ");

    const lines = rows.map((r) =>
      `• ${r.provider} [${r.status}] rep:${r.reputation} ${flags(r)}\n  default: ${r.defaultModel}\n  models: ${r.supportedModels.join(", ")}\n  budget: ${r.budget}`
    );

    const sourceNote = runtimeProviderOrder
      ? "(order set at runtime via set_provider_order)"
      : "(order from PROVIDER_ORDER env var or default)";

    return {
      content: [{
        type: "text",
        text: `Provider order ${sourceNote}: ${order.join(" → ")}\n\n${lines.join("\n\n")}`,
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
    text:     z.string().min(1).describe("The text to embed."),
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
  "Estimate the token count for a prompt + optional system prompt before sending it. Uses a word/char hybrid approximation. No API call is made.",
  {
    prompt:        z.string().describe("The prompt text to estimate."),
    system_prompt: z.string().optional().describe("Optional system prompt to include in the count."),
  },
  async ({ prompt, system_prompt }) => {
    const combined = [system_prompt, prompt].filter(Boolean).join("\n");
    const wordCount = combined.split(/\s+/).filter(Boolean).length;
    const charCount = combined.length;
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
  "Health-check all providers that have an API key configured. Sends a minimal prompt to each and reports latency, success/failure, and which model responded.",
  {
    providers: z.array(z.string()).optional().describe("Subset of providers to ping. Defaults to all configured ones."),
  },
  async ({ providers }) => {
    const keys = getApiKeys();
    const order = providers?.length ? resolveProviderAliases(providers) : getActiveProviderOrder();
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
        recordBenchmark(name, ms, true, 200);
        updateReputation(name, { success: true, latencyMs: ms, status: 200 });
        results.push({ provider: name, status: "ok", model: result.model, latencyMs: ms, response: result.text.slice(0, 80) });
      } catch (err) {
        const ms = Date.now() - start;
        const status = err instanceof ProviderError ? err.status : null;
        if (status === 429) markCooldown(name);
        recordBenchmark(name, ms, false, status);
        updateReputation(name, { success: false, latencyMs: ms, status });
        results.push({ provider: name, status: "error", latencyMs: ms, reason: buildReason(err) });
      }
    }

    const lines = results.map((r) => {
      if (r.status === "ok")    return `✅ ${r.provider} (${r.model}) — ${r.latencyMs}ms\n   "${r.response}"`;
      if (r.status === "error") return `❌ ${r.provider} — ${r.latencyMs}ms — ${r.reason}`;
      return                           `⏭  ${r.provider} — ${r.reason}`;
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
  "Show token usage and call counts for this session, broken down by provider. Also shows cache stats, budget usage against known free-tier limits, and the path to the persistent usage log file.",
  {},
  async () => {
    const stats = getSessionStats();
    const cache = cacheStats();
    const order = getActiveProviderOrder();
    const budgets = getAllBudgetUsage(order);

    const sessionLines = stats.length
      ? stats.map((s) =>
          `• ${s.provider}: ${s.calls} call(s), ${s.promptTokens} prompt tokens, ${s.completionTokens} completion tokens (${s.totalTokens} total)`
        )
      : ["  (no calls made this session yet)"];

    const budgetLines = budgets.map((b) =>
      `• ${b.provider}: ${b.count}${b.limit ? `/${b.limit}` : ""} per ${b.window}${b.nearLimit ? " ⚠️ near limit" : ""}`
    );

    return {
      content: [{
        type: "text",
        text: [
          "=== Session usage ===",
          ...sessionLines,
          "",
          "=== Budget usage (known free-tier limits) ===",
          ...budgetLines,
          "",
          "=== Response cache ===",
          `  Enabled: ${cache.enabled}`,
          `  Entries: ${cache.size}`,
          `  TTL: ${cache.ttlSeconds}s`,
          "",
          "=== Persistent log ===",
          `  Path: ${process.env.USAGE_LOG_PATH ?? "./usage-log.jsonl"}`,
          `  Enabled: ${process.env.USAGE_TRACKING !== "false"}`,
        ].join("\n"),
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool 7: set_provider_order
// ---------------------------------------------------------------------------

server.tool(
  "set_provider_order",
  "Dynamically change the provider fallback order at runtime without restarting the server or editing .env. The new order persists for the lifetime of this server session.",
  {
    order: z.array(z.string()).min(1).describe(
      `New provider order as an array. Valid values: ${ALL_PROVIDERS.join(", ")} (or any configured alias). Example: ["groq","gemini","openrouter"]`
    ),
  },
  async ({ order }) => {
    const resolved = resolveProviderAliases(order);
    const invalid = resolved.filter((p) => !PROVIDER_REGISTRY[p]);
    if (invalid.length) {
      throw new Error(`Unknown provider(s): ${invalid.join(", ")}. Valid: ${ALL_PROVIDERS.join(", ")}`);
    }

    const previous = getActiveProviderOrder().join(" → ");
    runtimeProviderOrder = [...resolved];
    const current = runtimeProviderOrder.join(" → ");

    log(`Provider order changed: ${previous} → ${current}`);

    return {
      content: [{
        type: "text",
        text: `Provider order updated.\n\nPrevious: ${previous}\nNew:      ${current}\n\nThis change is active for the current server session only. To make it permanent, set PROVIDER_ORDER=${resolved.join(",")} in .env.`,
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool 8: clear_cache
// ---------------------------------------------------------------------------

server.tool(
  "clear_cache",
  "Manually clear the in-memory response cache. Useful when you know upstream data changed and want fresh answers even for previously-cached prompts.",
  {},
  async () => {
    const removed = cacheClear();
    log(`Cache cleared — ${removed} entr${removed === 1 ? "y" : "ies"} removed`);
    return {
      content: [{
        type: "text",
        text: `Cache cleared. ${removed} entr${removed === 1 ? "y" : "ies"} removed.`,
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool 9: compare_providers
// ---------------------------------------------------------------------------

server.tool(
  "compare_providers",
  "Send the same prompt to multiple providers simultaneously and show all responses with latency side-by-side, for evaluating model quality/speed differences.",
  {
    prompt:        z.string().min(1).describe("The prompt to send to every provider."),
    system_prompt: z.string().optional().describe("Optional system prompt applied to every provider."),
    max_tokens:    z.number().int().min(1).max(8192).optional().default(512),
    temperature:   z.number().min(0).max(2).optional().default(0.7),
    providers:     z.array(z.string()).optional().describe("Providers to compare. Defaults to all configured providers with an API key."),
  },
  async ({ prompt, system_prompt, max_tokens = 512, temperature = 0.7, providers }) => {
    const keys = getApiKeys();
    const candidates = (providers?.length ? resolveProviderAliases(providers) : getActiveProviderOrder())
      .filter((p) => PROVIDER_REGISTRY[p] && keys[p]);

    if (!candidates.length) {
      throw new Error("No configured providers available to compare (check API keys).");
    }

    const results = await Promise.allSettled(
      candidates.map(async (name) => {
        const entry = PROVIDER_REGISTRY[name];
        const cap = getMaxTokensCap(name);
        const start = Date.now();
        const result = await entry.fn({
          prompt, systemPrompt: system_prompt, maxTokens: Math.min(max_tokens, cap),
          temperature, model: entry.defaultModel, apiKey: keys[name],
        });
        return { name, model: result.model, latencyMs: Date.now() - start, text: result.text };
      })
    );

    const lines = results.map((r, i) => {
      const name = candidates[i];
      if (r.status === "fulfilled") {
        return `### ${name} (${r.value.model}) — ${r.value.latencyMs}ms\n${r.value.text}`;
      }
      return `### ${name} — FAILED\n${buildReason(r.reason)}`;
    });

    return {
      content: [{
        type: "text",
        text: `Comparison across ${candidates.length} provider(s):\n\n${lines.join("\n\n---\n\n")}`,
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool 10: get_benchmarks
// ---------------------------------------------------------------------------

server.tool(
  "get_benchmarks",
  "Show average/p95 latency and success rate per provider, based on calls observed during this server's lifetime. Providers are auto-sorted by effective performance (fastest + most reliable first).",
  {},
  async () => {
    const order = getActiveProviderOrder();
    const benchmarks = getAllBenchmarks(order);

    if (!benchmarks.some((b) => b.calls > 0)) {
      return { content: [{ type: "text", text: "No benchmark data yet — make some chat_completion or ping_providers calls first." }] };
    }

    const lines = benchmarks.map((b) =>
      b.calls
        ? `• ${b.provider}: avg ${b.avgLatencyMs}ms, p95 ${b.p95LatencyMs}ms, success rate ${(b.successRate * 100).toFixed(1)}% (${b.calls} calls)`
        : `• ${b.provider}: no data yet`
    );

    return { content: [{ type: "text", text: `Benchmarks (sorted by effective performance):\n\n${lines.join("\n")}` }] };
  }
);

// ---------------------------------------------------------------------------
// Tool 11: chat_with_template
// ---------------------------------------------------------------------------

server.tool(
  "chat_with_template",
  `Run a saved prompt template from ./templates/*.md, filling in {{placeholder}} values, then send it through chat_completion's provider fallback chain. Available templates: ${listTemplates().join(", ") || "(none found — add .md files to ./templates)"}`,
  {
    template_name: z.string().describe("Name of the template file (without .md extension)."),
    variables:     z.record(z.string()).optional().default({}).describe("Key-value pairs to substitute into {{placeholder}} tokens in the template."),
    max_tokens:    z.number().int().min(1).max(8192).optional().default(1024),
    temperature:   z.number().min(0).max(2).optional().default(0.7),
    providers:     z.array(z.string()).optional(),
  },
  async ({ template_name, variables = {}, max_tokens = 1024, temperature = 0.7, providers }) => {
    const raw = loadTemplate(template_name);
    const filled = fillTemplate(raw, variables);
    return handleChatCompletion({ prompt: filled, max_tokens, temperature, providers });
  }
);

// ---------------------------------------------------------------------------
// Tool 12: summarize_usage_log
// ---------------------------------------------------------------------------

server.tool(
  "summarize_usage_log",
  "Aggregate usage-log.jsonl into per-provider and per-day summaries: most-used provider, peak hour, total tokens per day/week.",
  {
    since_days: z.number().int().min(1).optional().describe("Only include records from the last N days. Omit for all-time."),
  },
  async ({ since_days }) => {
    const since = since_days ? new Date(Date.now() - since_days * 86400000) : undefined;
    const summary = summarizeUsage({ since });

    const providerLines = Object.entries(summary.byProvider)
      .sort((a, b) => b[1].calls - a[1].calls)
      .map(([p, s]) => `• ${p}: ${s.calls} calls, ${s.totalTokens} tokens`);

    const dayLines = Object.entries(summary.byDay).map(([d, s]) => `• ${d}: ${s.calls} calls, ${s.totalTokens} tokens`);

    return {
      content: [{
        type: "text",
        text: [
          `Total calls: ${summary.totalCalls}`,
          `Total tokens: ${summary.totalTokens}`,
          `Most used provider: ${summary.mostUsedProvider ?? "—"}`,
          `Peak hour (local): ${summary.peakHour !== null ? `${summary.peakHour}:00` : "—"}`,
          "",
          "By provider:",
          ...providerLines,
          "",
          "By day:",
          ...dayLines,
        ].join("\n"),
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool 13: export_usage_report
// ---------------------------------------------------------------------------

server.tool(
  "export_usage_report",
  "Generate a Markdown or CSV usage report from usage-log.jsonl and write it to disk (default ./usage-report.md or .csv) for pasting into Notion/Obsidian/spreadsheets.",
  {
    format: z.enum(["markdown", "csv"]).optional().default("markdown"),
    output_path: z.string().optional().describe("Where to write the report. Defaults to ./usage-report.md or ./usage-report.csv depending on format."),
  },
  async ({ format = "markdown", output_path }) => {
    const { writeFileSync } = await import("fs");
    const content = format === "csv" ? buildCsvReport() : buildMarkdownReport();
    const path = resolve(output_path ?? (format === "csv" ? "./usage-report.csv" : "./usage-report.md"));
    writeFileSync(path, content, "utf8");
    return { content: [{ type: "text", text: `Report written to ${path} (${format}).` }] };
  }
);

// ---------------------------------------------------------------------------
// Tool 14: translate
// ---------------------------------------------------------------------------

server.tool(
  "translate",
  "Translate text between languages using a free-tier LLM — no DeepL/Google Translate API needed.",
  {
    text: z.string().min(1),
    from: z.string().describe("Source language, e.g. \"English\"."),
    to:   z.string().describe("Target language, e.g. \"Indonesian\"."),
  },
  async ({ text, from, to }) => {
    const filled = fillTemplate(loadTemplate("translate"), { text, from, to });
    return handleChatCompletion({ prompt: filled, max_tokens: 2048, temperature: 0.3 });
  }
);

// ---------------------------------------------------------------------------
// Tool 15: summarize
// ---------------------------------------------------------------------------

server.tool(
  "summarize",
  "Summarize a block of text using a free-tier LLM, with a tuned prompt for concise, faithful summaries.",
  {
    text: z.string().min(1),
    style: z.enum(["bullet", "paragraph", "tldr"]).optional().default("paragraph"),
    max_words: z.number().int().min(10).max(2000).optional().default(150),
  },
  async ({ text, style = "paragraph", max_words = 150 }) => {
    const filled = fillTemplate(loadTemplate("summarize"), { text, style, max_words: String(max_words) });
    return handleChatCompletion({ prompt: filled, max_tokens: 1024, temperature: 0.3 });
  }
);

// ---------------------------------------------------------------------------
// Tool 16: code_review
// ---------------------------------------------------------------------------

server.tool(
  "code_review",
  "Review a code snippet using a free-tier LLM with a tuned code-review prompt.",
  {
    code: z.string().min(1),
    language: z.string().optional().default("plaintext"),
    focus: z.enum(["security", "performance", "readability", "general"]).optional().default("general"),
  },
  async ({ code, language = "plaintext", focus = "general" }) => {
    const filled = fillTemplate(loadTemplate("code_review"), { code, language, focus });
    return handleChatCompletion({ prompt: filled, max_tokens: 2048, temperature: 0.2 });
  }
);

// ---------------------------------------------------------------------------
// Tool 17: get_reputation
// ---------------------------------------------------------------------------

server.tool(
  "get_reputation",
  "Show the Batch 6 provider reputation system: a 0-100 score per provider derived from response time, error rate, and 429 history, used to auto-reorder the fallback chain toward whichever provider is most reliable right now.",
  {},
  async () => {
    const order = getActiveProviderOrder();
    const snapshot = getReputationSnapshot(order);
    const sorted = [...snapshot].sort((a, b) => b.reputation - a.reputation);

    const lines = sorted.map((s) =>
      `• ${s.provider}: reputation ${s.reputation}/100${s.benchmark.calls ? ` (avg ${s.benchmark.avgLatencyMs}ms, ${(s.benchmark.successRate * 100).toFixed(0)}% success over ${s.benchmark.calls} calls)` : " (no data yet — neutral default)"}`
    );

    return {
      content: [{
        type: "text",
        text: `Provider reputation (highest first — this order influences chat_completion's auto-reordering):\n\n${lines.join("\n")}`,
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// MCP Resources — expose usage-log.jsonl and cooldown-state.json directly
// ---------------------------------------------------------------------------

server.resource(
  "usage-log",
  "file://usage-log.jsonl",
  async (uri) => {
    const path = resolve(process.env.USAGE_LOG_PATH ?? "./usage-log.jsonl");
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    return { contents: [{ uri: uri.href, mimeType: "application/x-ndjson", text }] };
  }
);

server.resource(
  "cooldown-state",
  "file://cooldown-state.json",
  async (uri) => {
    const path = resolve(process.env.COOLDOWN_STATE_PATH ?? "./cooldown-state.json");
    const text = existsSync(path) ? readFileSync(path, "utf8") : "{}";
    return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
  }
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// buildReason is now imported as sharedBuildReason from lib/router-core.js
const buildReason = sharedBuildReason;

// ---------------------------------------------------------------------------
// Startup health check — ping all configured providers on boot
// ---------------------------------------------------------------------------

async function startupHealthCheck() {
  const keys = getApiKeys();
  const configured = getActiveProviderOrder().filter((name) => keys[name]);

  if (!configured.length) {
    logError("No providers configured — set at least one API key in .env");
    return;
  }

  log(`Running startup health check for: ${configured.join(", ")}`);

  const checks = configured.map(async (name) => {
    const entry = PROVIDER_REGISTRY[name];
    const apiKey = keys[name];
    const start = Date.now();
    try {
      const result = await entry.fn({
        prompt: "Hi",
        systemPrompt: undefined,
        maxTokens: 5,
        temperature: 0.1,
        model: entry.defaultModel,
        apiKey,
      });
      const ms = Date.now() - start;
      recordBenchmark(name, ms, true, 200);
      updateReputation(name, { success: true, latencyMs: ms, status: 200 });
      log(`✅ ${name} (${result.model}) ready — ${ms}ms`);
    } catch (err) {
      const status = err instanceof ProviderError ? err.status : null;
      const ms = Date.now() - start;
      recordBenchmark(name, ms, false, status);
      updateReputation(name, { success: false, latencyMs: ms, status });
      if (status === 429) {
        markCooldown(name);
        logError(`⚠️  ${name} rate-limited at startup — cooldown started`);
      } else {
        logError(`❌ ${name} unreachable at startup — ${buildReason(err)}`);
      }
    }
  });

  await Promise.allSettled(checks);
  log("Startup health check complete");
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function setupGracefulShutdown() {
  const shutdown = (signal) => {
    log(`Received ${signal} — shutting down gracefully`);
    process.exit(0);
  };
  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logError(`Uncaught exception: ${err.message}\n${err.stack}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logError(`Unhandled rejection: ${reason}`);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

setupGracefulShutdown();

// Config validation — log warnings before anything else runs.
for (const warning of validateConfig()) {
  logError(`Config warning: ${warning}`);
}

const transport = new StdioServerTransport();
await server.connect(transport);

log("free-ai-router MCP server v4.0.0 started (stdio transport)");
log(`Provider order: ${getActiveProviderOrder().join(" → ")}`);

// Non-blocking startup health check — runs after server is ready
startupHealthCheck().catch((err) => logError(`Health check error: ${err.message}`));

// Optional background warm-up pool (PROVIDER_WARMUP_ENABLED=true)
startWarmupPool(
  () => getActiveProviderOrder().filter((n) => getApiKeys()[n]),
  PROVIDER_REGISTRY,
  getApiKeys
);

// Optional web dashboard (DASHBOARD_ENABLED=true)
startDashboard(() => {
  const order = getActiveProviderOrder();
  const keys = getApiKeys();
  const cooldownMap = Object.fromEntries(allCooldowns().map((c) => [c.provider, c.remainingSeconds]));
  const reputationSnapshot = getReputationSnapshot(order);
  const stats = getSessionStats();
  const totalCalls = stats.reduce((a, s) => a + s.calls, 0);
  const totalTokens = stats.reduce((a, s) => a + s.totalTokens, 0);

  const providers = order.map((name) => {
    const remaining = cooldownMap[name] ?? 0;
    const hasKey = Boolean(keys[name]);
    const status = !hasKey ? "no-key" : remaining > 0 ? `cooldown (${remaining}s)` : "active";
    const rep = reputationSnapshot.find((r) => r.provider === name);
    const statObj = stats.find((s) => s.provider === name);
    return {
      provider: name,
      status,
      reputation: rep?.reputation ?? 70,
      avgLatencyMs: rep?.benchmark?.avgLatencyMs ?? null,
      calls: statObj?.calls ?? 0,
    };
  });

  return {
    providers,
    totalCalls,
    totalTokens,
    cacheEntries: cacheStats().size,
    recentLog: "(see /api/status or usage-log.jsonl for raw data)",
  };
});
