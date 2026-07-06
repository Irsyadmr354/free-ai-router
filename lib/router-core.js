/**
 * lib/router-core.js
 * Shared provider fallback-chain logic, extracted from index.js so both the
 * MCP entry point (index.js) and the HTTP entry point (http-server.js) can
 * reuse the exact same PROVIDER_REGISTRY + executeProviderChain without
 * duplicating logic in two places.
 *
 * Generic over streaming vs non-streaming: pass `onDelta` in the options
 * object to executeProviderChain to take the stream*() code path for
 * providers that support it; omit it (or pass nothing) to use the existing
 * call*() non-streaming path exactly as before.
 */

import { ProviderError } from "./normalize.js";
import { log, logError } from "./logger.js";
import { markCooldown, isOnCooldown, cooldownRemainingSeconds, clearCooldown } from "./cooldown.js";
import { recordUsage } from "./usage-tracker.js";
import {
  isModelFallbackEnabled, getMaxTokensCap, getSystemInjections,
  getSimulatedFailures, isQualityScoringEnabled, getMaxRetriesPerProvider,
} from "./config.js";
import { notifyAllProvidersFailed } from "./notifier.js";
import { recordBudgetUsage, deprioritizeNearLimitProviders } from "./budget-tracker.js";
import { scoreResponseQuality } from "./quality-score.js";
import { recordBenchmark, sortByBenchmark } from "./benchmark.js";
import { updateReputation, sortByReputation } from "./reputation.js";
import { circuitAllows, cbRecordSuccess, cbRecordFailure, circuitRemainingSeconds } from "./circuit-breaker.js";
import { queueOrRun, msUntilAnyProviderAvailable } from "./request-queue.js";
import { applyTaskRouting } from "./task-routing.js";
import { runTokenSavingPipeline } from "./token-saver.js";
import { recordMabOutcome, sortByMab } from "./mab-routing.js";
import { recordAnomalyDataPoint, deprioritizeDegradedProviders } from "./anomaly-detector.js";
import { analyzeAndRoute } from "./prompt-analyzer.js";
import { saveExchange } from "./conversations.js";

// Providers — non-streaming call*() (existing, reused as-is)
import { callGemini, streamGemini, SUPPORTED_MODELS as GEMINI_MODELS, DEFAULT_MODEL as GEMINI_DEFAULT } from "../providers/gemini.js";
import { callGroq, streamGroq, SUPPORTED_MODELS as GROQ_MODELS, CHAT_MODELS as GROQ_CHAT_MODELS, DEFAULT_MODEL as GROQ_DEFAULT } from "../providers/groq.js";
import { callOpenRouter, streamOpenRouter, SUPPORTED_MODELS as OR_MODELS, DEFAULT_MODEL as OR_DEFAULT } from "../providers/openrouter.js";
import { callCloudflare, streamCloudflare, SUPPORTED_MODELS as CF_MODELS, DEFAULT_MODEL as CF_DEFAULT } from "../providers/cloudflare.js";
import { callCohere, streamCohere, SUPPORTED_MODELS as COHERE_MODELS, DEFAULT_MODEL as COHERE_DEFAULT } from "../providers/cohere.js";
import { callMistral, streamMistral, SUPPORTED_MODELS as MISTRAL_MODELS, DEFAULT_MODEL as MISTRAL_DEFAULT } from "../providers/mistral.js";
import { callOpenCodeZen, streamOpenCodeZen, SUPPORTED_MODELS as ZEN_MODELS, DEFAULT_MODEL as ZEN_DEFAULT } from "../providers/opencode-zen.js";

// ---------------------------------------------------------------------------
// Provider registry — maps name → call function + metadata
// ---------------------------------------------------------------------------

export const PROVIDER_REGISTRY = {
  gemini:     { fn: callGemini,     streamFn: streamGemini,     models: GEMINI_MODELS,    chatModels: GEMINI_MODELS,     defaultModel: GEMINI_DEFAULT,  supportsImages: true,  supportsTools: true,  supportsStream: false, supportsJsonMode: true  },
  groq:       { fn: callGroq,       streamFn: streamGroq,       models: GROQ_MODELS,      chatModels: GROQ_CHAT_MODELS,  defaultModel: GROQ_DEFAULT,    supportsImages: false, supportsTools: true,  supportsStream: true,  supportsJsonMode: true  },
  openrouter: { fn: callOpenRouter, streamFn: streamOpenRouter, models: OR_MODELS,        chatModels: OR_MODELS,         defaultModel: OR_DEFAULT,      supportsImages: false, supportsTools: true,  supportsStream: true,  supportsJsonMode: true  },
  cloudflare: { fn: callCloudflare, streamFn: streamCloudflare, models: CF_MODELS,        chatModels: CF_MODELS,         defaultModel: CF_DEFAULT,      supportsImages: false, supportsTools: false, supportsStream: true,  supportsJsonMode: false },
  cohere:     { fn: callCohere,     streamFn: streamCohere,     models: COHERE_MODELS,    chatModels: COHERE_MODELS,     defaultModel: COHERE_DEFAULT,  supportsImages: false, supportsTools: false, supportsStream: true,  supportsJsonMode: false },
  mistral:    { fn: callMistral,    streamFn: streamMistral,    models: MISTRAL_MODELS,   chatModels: MISTRAL_MODELS,    defaultModel: MISTRAL_DEFAULT, supportsImages: false, supportsTools: true,  supportsStream: true,  supportsJsonMode: true  },
  "opencode-zen": { fn: callOpenCodeZen, streamFn: streamOpenCodeZen, models: ZEN_MODELS, chatModels: ZEN_MODELS,        defaultModel: ZEN_DEFAULT,     supportsImages: false, supportsTools: true,  supportsStream: true,  supportsJsonMode: true  },
};

export const ALL_PROVIDER_NAMES = Object.keys(PROVIDER_REGISTRY);

/**
 * Apply the full provider reordering pipeline:
 *   1. Budget deprioritization (near-limit providers go last)
 *   2. Anomaly deprioritization (latency-spiking providers go last)
 *   3. MAB (UCB1) sorting — replaces simple reputation sort
 *   4. Reputation sort as tiebreaker when MAB has no data
 * Kept here so both entry points reorder identically.
 */
export function reorderProviders(order) {
  let result = deprioritizeNearLimitProviders(order);
  result = deprioritizeDegradedProviders(result);
  result = sortByMab(result);
  result = sortByReputation(result); // tiebreaker for providers with equal MAB scores
  return result;
}

/**
 * Reorder providers using prompt analysis affinity when PROMPT_ANALYSIS_ROUTING=true.
 * Falls back to standard reorderProviders if disabled or on error.
 */
export function reorderProvidersForPrompt(order, prompt, systemPrompt) {
  try {
    const { order: analyzed } = analyzeAndRoute(prompt ?? "", systemPrompt ?? "", order);
    // Apply budget + anomaly constraints on top of affinity ordering
    let result = deprioritizeNearLimitProviders(analyzed);
    result = deprioritizeDegradedProviders(result);
    return result;
  } catch {
    return reorderProviders(order);
  }
}

/**
 * Execute the provider fallback chain: tries each provider (and, within a
 * provider, each fallback model) in order, skipping providers on cooldown /
 * without keys / simulated-failed, applying smart retry on network errors,
 * quality-score soft-fail, and recording benchmark/reputation/budget/usage
 * exactly like index.js always has.
 *
 * Generic over streaming: if `onDelta` is provided in the options, the
 * provider's streamFn is used and onDelta(text) is invoked per chunk as it
 * arrives. If omitted, the existing non-streaming fn is used and the full
 * text is returned in one shot (identical behavior to before).
 *
 * @param {object} opts
 * @param {string[]} opts.order - resolved provider order to try
 * @param {Record<string,string>} opts.keys - apiKeys map from getApiKeys()
 * @param {string} [opts.model] - forced model override
 * @param {object} opts.params - call params (prompt/messages/systemPrompt/maxTokens/temperature/tools/etc)
 * @param {Array} [opts.tools]
 * @param {string|object} [opts.tool_choice]
 * @param {string} [opts.response_format]
 * @param {boolean} [opts.hasImage]
 * @param {(delta: string) => void} [opts.onDelta] - if present, use streaming path
 * @param {AbortSignal} [opts.abortSignal] - forwarded to stream calls so client disconnects can cancel upstream
 * @returns {Promise<object>} normalized success result (same shape as call*() return)
 */
export async function executeProviderChain({
  order, keys, model, params, tools, tool_choice, response_format,
  hasImage, session_id, sanitizeNote = "", verbose = false, onDelta, abortSignal, task_type,
  allowLossySummarization = false, abbreviationDictionary, compactData = false,
}) {
  const errors = {};
  const skippedReasons = {};
  const fallbackEnabled = isModelFallbackEnabled();
  const systemInjections = getSystemInjections();
  const simulatedFailures = getSimulatedFailures();
  const maxRetriesPerProvider = getMaxRetriesPerProvider();

  // -------------------------------------------------------------------------
  // Token saving pipeline — runs AFTER cache (handled by callers) and BEFORE
  // the provider loop. Results stored in _tokenSavingMeta on the response.
  // -------------------------------------------------------------------------
  const { params: savedParams, meta: tokenSavingMeta } = await runTokenSavingPipeline(params, {
    allowLossySummarization,
    abbreviationDictionary,
    compactData,
    executeProviderChain,
    order,
    keys,
  });
  params = savedParams;

  for (const providerName of order) {
    const entry = PROVIDER_REGISTRY[providerName];
    if (!entry) {
      logError(`Unknown provider "${providerName}" in order list — skipping`);
      errors[providerName] = "Unknown provider";
      continue;
    }

    if (hasImage && !entry.supportsImages) {
      skippedReasons[providerName] = "Does not support image input";
      continue;
    }
    if (tools?.length && !entry.supportsTools) {
      skippedReasons[providerName] = "Does not support tool calling — tried anyway only if no tool-capable provider remains";
    }
    if (response_format === "json" && !entry.supportsJsonMode) {
      skippedReasons[providerName] = "Does not support native JSON mode — may not honor response_format";
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

    if (!circuitAllows(providerName)) {
      const secs = circuitRemainingSeconds(providerName);
      log(`Skipping ${providerName} — circuit open for ${secs}s more`);
      errors[providerName] = `Circuit breaker open for ${secs}s (too many recent errors)`;
      continue;
    }

    if (simulatedFailures.has(providerName)) {
      log(`Simulating 429 for ${providerName} (SIMULATE_FAILURES)`);
      markCooldown(providerName);
      errors[providerName] = "Simulated failure (SIMULATE_FAILURES)";
      continue;
    }

    const maxTokensCap = getMaxTokensCap(providerName);
    const effectiveMaxTokens = Math.min(params.maxTokens, maxTokensCap);
    const cappedNote = effectiveMaxTokens < params.maxTokens ? ` (max_tokens clamped ${params.maxTokens}→${effectiveMaxTokens} for ${providerName})` : "";

    const primaryModel = model ?? entry.defaultModel;
    // Use chatModels for fallback iteration — excludes non-chat models (whisper,
    // prompt-guard, TTS) so the fallback chain never tries them for chat requests.
    const fallbackList = entry.chatModels ?? entry.models;
    let modelCandidates = fallbackEnabled
      ? [primaryModel, ...fallbackList.filter((m) => m !== primaryModel)]
      : [primaryModel];
    // Semantic model routing: if the caller didn't force a specific `model`
    // and gave a task_type hint, reorder this provider's fallback candidates
    // so the model best-suited for that task (by name heuristic) is tried
    // first, instead of always starting from the provider's generic default.
    if (!model && task_type && fallbackEnabled) {
      modelCandidates = applyTaskRouting(task_type, modelCandidates);
    }
    modelCandidates = modelCandidates.slice(0, maxRetriesPerProvider);

    const modelErrors = [];

    // Choose streaming vs non-streaming call function for this provider.
    const useStreaming = Boolean(onDelta) && entry.supportsStream && typeof entry.streamFn === "function";
    const fnToUse = useStreaming ? entry.streamFn : entry.fn;

    for (const chosenModel of modelCandidates) {
      log(`Trying ${providerName} (${chosenModel})${useStreaming ? " [stream]" : ""}…`);
      const callStart = Date.now();

      try {
        const callParams = { ...params, maxTokens: effectiveMaxTokens, model: chosenModel, apiKey };
        if (systemInjections[providerName]) {
          callParams.systemPrompt = callParams.systemPrompt
            ? `${callParams.systemPrompt}\n\n${systemInjections[providerName]}`
            : systemInjections[providerName];
        }
        if (tools?.length) {
          // Each provider has a max tools per request cap. Exceed it → HTTP 400.
          // Cap known limits; default to passing all if unknown.
          const TOOLS_CAP = { groq: 128, mistral: 64, gemini: 128 };
          const cap = TOOLS_CAP[providerName];
          callParams.tools = cap ? tools.slice(0, cap) : tools;
          if (tool_choice) callParams.toolChoice = tool_choice;
        }
        if (response_format === "json") {
          callParams.responseFormat = "json";
        }

        if (useStreaming) {
          callParams.onDelta = onDelta;
          if (abortSignal) callParams.abortSignal = abortSignal;
        }

        const result = await callWithSmartRetry(fnToUse, callParams, providerName);

        // If the caller wanted streaming but this provider doesn't support it
        // (or it fell back to the non-streaming fn for some other reason),
        // `onDelta` is never invoked by fnToUse — the client would otherwise
        // receive a "successful" stream with zero content. Simulate a single-
        // chunk stream here so the full text still reaches the client.
        if (onDelta && !useStreaming && result.text) {
          onDelta(result.text);
        }

        const latencyMs = Date.now() - callStart;

        // Quality scoring — treat a low-quality 200 OK as a soft failure and
        // try the next candidate, unless this was the very last option anywhere.
        // Skipped for streaming responses already forwarded to the client —
        // by the time we could reject it, partial content is already sent.
        if (!useStreaming && isQualityScoringEnabled() && !result.toolCalls?.length) {
          const quality = scoreResponseQuality(result.text, effectiveMaxTokens);
          if (!quality.passed) {
            modelErrors.push(`${chosenModel}: failed quality check (${quality.reasons.join("; ")})`);
            recordBenchmark(providerName, latencyMs, false, 200);
            updateReputation(providerName, { success: false, latencyMs, status: 200 });
            logError(`${providerName}/${chosenModel} — response failed quality check, trying next candidate`);
            if (!fallbackEnabled) break;
            continue;
          }
        }

        clearCooldown(providerName);
        cbRecordSuccess(providerName);
        recordBenchmark(providerName, latencyMs, true, 200);
        updateReputation(providerName, { success: true, latencyMs, status: 200 });
        recordMabOutcome(providerName, { success: true, latencyMs, status: 200 });
        recordAnomalyDataPoint(providerName, latencyMs, true);
        recordBudgetUsage(providerName);
        log(`Success via ${providerName} (${result.model}) — ${latencyMs}ms`);
        recordUsage(result.provider, result.model, result.usage.promptTokens, result.usage.completionTokens, session_id ?? null);

        // Persist conversation exchange to SQLite if conversation storage enabled
        if (params.prompt && result.text) {
          try {
            saveExchange({
              conversationId: session_id,
              userPrompt: params.prompt,
              assistantResponse: result.text,
              provider: result.provider,
              model: result.model,
              promptTokens: result.usage?.promptTokens ?? 0,
              completionTokens: result.usage?.completionTokens ?? 0,
              sessionId: session_id,
            });
          } catch { /* non-fatal — never block a successful response */ }
        }

        result._meta = {
          fallbackModel: chosenModel !== primaryModel ? primaryModel : null,
          cappedNote,
          sanitizeNote,
          skippedReasons,
          errors,
          tokenSaving: tokenSavingMeta,
        };

        return result;
      } catch (err) {
        const latencyMs = Date.now() - callStart;
        const reason = buildReason(err);
        modelErrors.push(`${chosenModel}: ${reason}`);
        const status = err instanceof ProviderError ? err.status : null;
        recordBenchmark(providerName, latencyMs, false, status);
        updateReputation(providerName, { success: false, latencyMs, status });
        cbRecordFailure(providerName, status);
        recordMabOutcome(providerName, { success: false, latencyMs, status });
        recordAnomalyDataPoint(providerName, latencyMs, false);

        if (err instanceof ProviderError && err.status === 429) {
          markCooldown(providerName);
          log(`${providerName} rate-limited (429) — cooldown started, trying next provider`);
          break;
        }
        if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) {
          logError(`${providerName} auth failed (${err.status}) — trying next provider`);
          break;
        }
        if (!fallbackEnabled) break;

        logError(`${providerName}/${chosenModel} failed — ${reason} — trying next model in provider`);
      }
    }

    errors[providerName] = modelErrors.join(" | ");
  }

  const errorSummary = Object.entries(errors).map(([p, r]) => `${p}: ${r}`).join(". ");

  // Check if all providers failed only due to cooldown/circuit — if so, queue
  // the request and retry automatically when the soonest one recovers.
  const waitMs = msUntilAnyProviderAvailable(order, keys);
  if (waitMs > 0 && waitMs !== Infinity) {
    return queueOrRun(order, keys, () => executeProviderChain({
      order, keys, model, params, tools, tool_choice, response_format,
      hasImage, session_id, sanitizeNote, verbose, onDelta, abortSignal, task_type,
      allowLossySummarization, abbreviationDictionary, compactData,
    }));
  }

  notifyAllProvidersFailed(errorSummary).catch(() => {});
  throw new Error(`All providers failed. ${errorSummary}.`);
}

/**
 * Wrap a provider call with one smart retry on network/timeout errors
 * (status === null) — a brief 1s delay, same provider, same model, since
 * an occasional blip shouldn't burn a whole provider's fallback slot.
 */
export async function callWithSmartRetry(fn, callParams, providerName) {
  try {
    return await fn(callParams);
  } catch (err) {
    if (err instanceof ProviderError && err.status === null) {
      log(`${providerName} network/timeout error — retrying once after 1s`);
      await new Promise((r) => setTimeout(r, 1000));
      return await fn(callParams);
    }
    throw err;
  }
}

export function buildReason(err) {
  if (err instanceof ProviderError) {
    const statusPart = err.status !== null ? ` (HTTP ${err.status})` : " (network/timeout)";
    const rawPart = err.rawMessage ? `: ${err.rawMessage.slice(0, 200)}` : "";
    return `${err.message}${statusPart}${rawPart}`;
  }
  return String(err?.message ?? err);
}
