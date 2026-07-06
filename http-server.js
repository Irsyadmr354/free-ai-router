#!/usr/bin/env node
/**
 * http-server.js
 * OpenAI-compatible HTTP entry point for free-ai-router (v4.0.0).
 *
 * This exists alongside index.js (the original MCP/stdio entry point,
 * kept but no longer the primary way to use the router) to let ANY tool
 * that supports a custom "OpenAI API Base URL" — GUI IDEs (Cursor,
 * Antigravity IDE, Kiro IDE) and CLI tools (opencode, Claude Code, Kiro CLI,
 * Antigravity CLI, etc) — point straight at this router as their main model,
 * not just as an optional MCP tool.
 *
 * Endpoints:
 *   POST /v1/chat/completions  — OpenAI-compatible chat completion (stream + non-stream)
 *   GET  /v1/models            — list of all models across all configured providers
 *   GET  /v1/health (or /health) — quick config validation / debug endpoint
 *
 * Uses Node's built-in http module (no Express) — this project has zero
 * runtime deps beyond @modelcontextprotocol/sdk, zod, and dotenv, and the
 * routing here is only 3 simple endpoints, so pulling in Express purely for
 * routing sugar isn't worth the added dependency weight. If more endpoints
 * or middleware needs grow later, revisit this decision.
 *
 * Why localhost-only, no auth: per project decision, this server is meant
 * to be run locally alongside GUI IDEs/CLI tools on the same machine. The
 * API key field in those tools can be set to any non-empty string (e.g.
 * "free-ai-router") since the real provider auth lives in this server's
 * .env, not in anything the client sends.
 */

import "dotenv/config";
import { createServer } from "http";
import { randomUUID } from "crypto";
import { log, logError } from "./lib/logger.js";
import {
  getApiKeys, getProviderOrder, resolveProviderAliases, validateConfig,
  isMultiLanguagePromptEnabled,
} from "./lib/config.js";
import { sanitizePrompt } from "./lib/sanitize.js";
import { detectLanguageHint } from "./lib/lang-detect.js";
import { buildKey, cacheGet, cacheSet } from "./lib/cache.js";
import { dedupe } from "./lib/dedup.js";
import { chunkContext } from "./lib/chunk.js";
import { PROVIDER_REGISTRY, reorderProviders, executeProviderChain, buildReason } from "./lib/router-core.js";
import { forwardStream } from "./lib/sse-forward.js";
import { syncModels as syncOpenCodeZenModels } from "./providers/opencode-zen.js";
import { syncFreeModels as syncOpenRouterModels } from "./providers/openrouter.js";

const PORT = parseInt(process.env.PORT ?? "8787", 10);

// ---------------------------------------------------------------------------
// Helpers shared by both the streaming and non-streaming request paths
// ---------------------------------------------------------------------------

/**
 * Resolve provider order + apply the same budget/benchmark/reputation
 * reorder heuristics used by index.js's chat_completion tool, plus image
 * routing (Gemini-only) and tool-capable-provider prioritization.
 */
function resolveOrder({ providers, hasImage, tools }) {
  let order = providers?.length ? resolveProviderAliases(providers) : getProviderOrder();

  if (hasImage) {
    if (!order.includes("gemini")) {
      throw new Error(`image input is only supported via the Gemini provider, but "gemini" is not in the active provider list (${order.join(", ")}).`);
    }
    return ["gemini"];
  }

  order = reorderProviders(order);

  if (tools?.length) {
    const toolCapable = order.filter((p) => PROVIDER_REGISTRY[p]?.supportsTools);
    if (toolCapable.length) order = [...toolCapable, ...order.filter((p) => !toolCapable.includes(p))];
  }

  return order;
}

/**
 * Build the internal `params` object executeProviderChain expects, from an
 * OpenAI-style request body ({ model, messages, max_tokens, temperature,
 * tools, tool_choice, response_format }).
 */
function buildParamsFromOpenAiBody(body) {
  const { messages = [], max_tokens = 1024, temperature = 0.7 } = body;

  const systemMsg = messages.find((m) => m.role === "system");
  const chatMessages = messages.filter((m) => m.role !== "system");

  let systemPrompt = systemMsg?.content;
  if (isMultiLanguagePromptEnabled()) {
    const lastUser = [...chatMessages].reverse().find((m) => m.role === "user");
    if (lastUser?.content) {
      const langHint = detectLanguageHint(lastUser.content);
      if (langHint) {
        const nudge = `Respond in ${langHint}, matching the language of the user's message.`;
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${nudge}` : nudge;
      }
    }
  }

  // Sanitize each user message's text content before it leaves the process.
  let sanitizeNote = "";
  const sanitizedMessages = chatMessages.map((m) => {
    if (m.role !== "user" || typeof m.content !== "string") return m;
    const s = sanitizePrompt(m.content);
    if (s.truncated || s.redactions) {
      sanitizeNote = ` [sanitized: ${s.truncated ? "truncated; " : ""}${s.redactions ? `${s.redactions} possible API key(s) redacted` : ""}]`.trim();
    }
    return { ...m, content: s.text };
  });

  const params = {
    prompt: sanitizedMessages.map((m) => `${m.role}: ${m.content}`).join("\n"),
    systemPrompt,
    messages: sanitizedMessages,
    maxTokens: max_tokens,
    temperature,
  };

  return { params, sanitizeNote };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// POST /v1/chat/completions
// ---------------------------------------------------------------------------

async function handleChatCompletions(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: { message: err.message, type: "invalid_request_error" } });
  }

  const {
    model, messages, stream = false, providers, tools, tool_choice,
    response_format, session_id,
  } = body;

  if (!Array.isArray(messages) || !messages.length) {
    return sendJson(res, 400, { error: { message: "`messages` is required and must be a non-empty array.", type: "invalid_request_error" } });
  }

  const hasImage = messages.some((m) =>
    Array.isArray(m.content) && m.content.some((c) => c.type === "image_url")
  );
  // Note: OpenAI multi-modal content blocks aren't unpacked into
  // imageUrl/imageBase64 params here — this router's image support is
  // Gemini-specific (image_url/image_base64 top-level params in the MCP
  // tool). Multi-part `content` arrays with image_url blocks are treated as
  // text-only for now; extend here if IDE/CLI clients start sending images
  // through this endpoint.

  const keys = getApiKeys();
  const responseFormatValue = response_format?.type === "json_object" ? "json" : response_format === "json" ? "json" : "text";

  let order;
  try {
    order = resolveOrder({ providers, hasImage, tools });
  } catch (err) {
    return sendJson(res, 400, { error: { message: err.message, type: "invalid_request_error" } });
  }

  const { params, sanitizeNote } = buildParamsFromOpenAiBody(body);

  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    // True SSE forwarding — no collect-all-then-return.
    return forwardStream(res, req, {
      id,
      model: model ?? "free-ai-router",
      source: async ({ onDelta, abortSignal }) => {
        const result = await executeProviderChain({
          order, keys, model, params, tools, tool_choice,
          response_format: responseFormatValue, hasImage, session_id,
          sanitizeNote, onDelta, abortSignal,
        });
        return { model: `${result.provider}/${result.model}` };
      },
    });
  }

  // Non-streaming: identical behavior to before, just returned as OpenAI JSON.
  const cacheKey = buildKey({
    model, prompt: params.prompt, system_prompt: params.systemPrompt,
    max_tokens: params.maxTokens, temperature: params.temperature,
  });
  const skipCache = hasImage || Boolean(tools?.length);

  try {
    let result;
    if (!skipCache) {
      const cached = cacheGet(cacheKey);
      if (cached) {
        result = cached;
      }
    }
    if (!result) {
      const runOnce = () => executeProviderChain({
        order, keys, model, params, tools, tool_choice,
        response_format: responseFormatValue, hasImage, session_id, sanitizeNote,
      });
      result = skipCache ? await runOnce() : await dedupe(cacheKey, runOnce);
      if (!skipCache) cacheSet(cacheKey, result);
    }

    const message = { role: "assistant", content: result.text ?? "" };
    if (result.toolCalls?.length) message.tool_calls = result.toolCalls;

    return sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model: `${result.provider}/${result.model}`,
      choices: [{ index: 0, message, finish_reason: result.toolCalls?.length ? "tool_calls" : "stop" }],
      usage: {
        prompt_tokens: result.usage.promptTokens,
        completion_tokens: result.usage.completionTokens,
        total_tokens: result.usage.promptTokens + result.usage.completionTokens,
      },
    });
  } catch (err) {
    logError(`chat_completion failed: ${err.message}`);
    return sendJson(res, 502, { error: { message: err.message, type: "upstream_error" } });
  }
}

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------

function handleModels(req, res) {
  const created = Math.floor(Date.now() / 1000);
  const data = [];
  for (const [providerName, entry] of Object.entries(PROVIDER_REGISTRY)) {
    for (const modelId of entry.models) {
      data.push({ id: modelId, object: "model", created, owned_by: "free-ai-router", provider: providerName });
    }
  }
  return sendJson(res, 200, { object: "list", data });
}

// ---------------------------------------------------------------------------
// GET /v1/health
// ---------------------------------------------------------------------------

function handleHealth(req, res) {
  const warnings = validateConfig();
  const keys = getApiKeys();
  const configured = Object.keys(PROVIDER_REGISTRY).filter((p) => keys[p]);
  return sendJson(res, 200, {
    status: warnings.length ? "warnings" : "ok",
    configuredProviders: configured,
    warnings,
    port: PORT,
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return await handleChatCompletions(req, res);
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return handleModels(req, res);
    }
    if (req.method === "GET" && (url.pathname === "/v1/health" || url.pathname === "/health")) {
      return handleHealth(req, res);
    }

    return sendJson(res, 404, { error: { message: `Not found: ${req.method} ${url.pathname}`, type: "invalid_request_error" } });
  } catch (err) {
    logError(`Unhandled error in request handler: ${err.stack ?? err.message}`);
    if (!res.headersSent) {
      sendJson(res, 500, { error: { message: "Internal server error", type: "server_error" } });
    } else {
      try { res.end(); } catch {}
    }
  }
});

function setupGracefulShutdown() {
  const shutdown = (signal) => {
    log(`Received ${signal} — shutting down gracefully`);
    server.close(() => process.exit(0));
    // Force-exit if connections don't close in time (e.g. hung SSE streams).
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logError(`Uncaught exception: ${err.message}\n${err.stack}`);
  });
  process.on("unhandledRejection", (reason) => {
    logError(`Unhandled rejection: ${reason}`);
  });
}

setupGracefulShutdown();

for (const warning of validateConfig()) {
  logError(`Config warning: ${warning}`);
}

server.listen(PORT, "127.0.0.1", () => {
  const base = `http://localhost:${PORT}/v1`;
  log(`free-ai-router HTTP server v4.0.0 started`);
  log(`Base URL for IDE/CLI "custom OpenAI API endpoint" settings: ${base}`);
  log(`API key field: any non-empty string works (e.g. "free-ai-router") — real auth is server-side via .env`);
  log(`Endpoints: POST ${base}/chat/completions | GET ${base}/models | GET ${base}/health`);
  log(`Provider order: ${getProviderOrder().join(" → ")}`);

  // Sync OpenCode Zen free model list from API
  const zenKey = getApiKeys()["opencode-zen"];
  if (zenKey) syncOpenCodeZenModels(zenKey).catch(() => {});

  // Sync OpenRouter free model list from live API (no auth required)
  syncOpenRouterModels().catch(() => {});
});
