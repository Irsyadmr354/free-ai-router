/**
 * lib/middleware.js
 * Composable request middleware pipeline.
 *
 * Replaces the linear sequence of operations in executeProviderChain with
 * an injectable chain of named middleware functions. Each middleware receives
 * (context, next) where context is the mutable request state and next()
 * calls the remaining chain.
 *
 * Usage:
 *   const pipeline = createPipeline([
 *     sanitizeMiddleware,
 *     tokenSavingMiddleware,
 *     cacheMiddleware,
 *     routingMiddleware,
 *   ]);
 *   const result = await pipeline.run(context);
 *
 * Built-in middleware (in execution order):
 *   1. validateMiddleware     — input validation
 *   2. sanitizeMiddleware     — null bytes, API key redaction, length cap
 *   3. langDetectMiddleware   — multi-language system prompt injection
 *   4. tokenSavingMiddleware  — Tier 0-3 token saving pipeline
 *   5. cacheMiddleware        — response cache check/set
 *   6. dedupMiddleware        — in-flight request deduplication
 *   7. providerSelectMiddleware — MAB + budget + reputation reordering
 *   8. providerChainMiddleware  — actual provider fallback loop
 */

import { log, logError } from "./logger.js";

/**
 * @typedef {object} RequestContext
 * @property {object} params         — call params (prompt, messages, etc.)
 * @property {string[]} order        — provider order (may be mutated by middleware)
 * @property {Record<string,string>} keys — API keys
 * @property {object} options        — original call options (model, tools, etc.)
 * @property {object} meta           — accumulated metadata for response._meta
 * @property {any} [result]          — set by providerChainMiddleware on success
 * @property {boolean} [fromCache]   — set by cacheMiddleware
 */

/**
 * Create a middleware pipeline.
 * @param {Array<(ctx: RequestContext, next: () => Promise<void>) => Promise<void>>} middlewares
 */
export function createPipeline(middlewares) {
  return {
    /**
     * Run all middleware in sequence.
     * @param {RequestContext} context
     * @returns {Promise<RequestContext>}
     */
    async run(context) {
      let idx = -1;

      const dispatch = async (i) => {
        if (i <= idx) throw new Error("next() called multiple times");
        idx = i;
        const fn = middlewares[i];
        if (!fn) return; // end of chain
        await fn(context, () => dispatch(i + 1));
      };

      await dispatch(0);
      return context;
    },

    /**
     * Add middleware to the end of the pipeline (returns new pipeline).
     * @param {Function} mw
     */
    use(mw) {
      return createPipeline([...middlewares, mw]);
    },
  };
}

/**
 * Build the default pipeline context from executeProviderChain options.
 * @param {object} opts — same as executeProviderChain params
 * @returns {RequestContext}
 */
export function buildContext(opts) {
  return {
    params: { ...opts.params },
    order: [...(opts.order ?? [])],
    keys: opts.keys ?? {},
    options: {
      model: opts.model,
      tools: opts.tools,
      tool_choice: opts.tool_choice,
      response_format: opts.response_format,
      hasImage: opts.hasImage ?? false,
      session_id: opts.session_id,
      verbose: opts.verbose ?? false,
      task_type: opts.task_type,
      onDelta: opts.onDelta,
      abortSignal: opts.abortSignal,
      allowLossySummarization: opts.allowLossySummarization ?? false,
      abbreviationDictionary: opts.abbreviationDictionary,
      compactData: opts.compactData ?? false,
    },
    meta: {
      sanitizeNote: opts.sanitizeNote ?? "",
      skippedReasons: {},
      errors: {},
    },
    result: null,
    fromCache: false,
  };
}

/**
 * Logging middleware — logs when pipeline starts and ends.
 * Useful for debugging; disable via PIPELINE_LOGGING=false.
 */
export function loggingMiddleware(ctx, next) {
  if (process.env.PIPELINE_LOGGING === "false") return next();
  const start = Date.now();
  return next().then(() => {
    const ms = Date.now() - start;
    if (ctx.result && !ctx.fromCache) {
      log(`Pipeline complete — ${ctx.result.provider}/${ctx.result.model} in ${ms}ms`);
    }
  });
}
