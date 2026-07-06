/**
 * lib/task-routing.js
 * Semantic model routing (ROADMAP backlog #15).
 *
 * Given a `task_type` hint ("code" | "chat" | "math"), pick the most
 * suitable model *within* whichever provider ends up being tried, by
 * reordering that provider's model-fallback candidate list so the
 * best-suited model for the task is attempted first (falling back to the
 * provider's usual default/model-fallback order if none of the task's
 * preferred models are available on that provider).
 *
 * This does not change *provider* order — budget/benchmark/reputation
 * heuristics already handle that — it only influences which *model* is
 * requested first for a given provider once that provider's turn comes up
 * in the fallback chain.
 *
 * Keyword-substring matching against each provider's SUPPORTED_MODELS is
 * used rather than a hardcoded model->provider table, so this keeps working
 * as OpenRouter's synced free-model list changes over time.
 */

export const TASK_TYPES = ["code", "chat", "math"];

// Ordered list of substrings that, if found in a model id (case-insensitive),
// suggest strong suitability for the task. Earlier entries are preferred.
const TASK_MODEL_HINTS = {
  code: ["coder", "code", "codestral", "deepseek", "qwen2.5-coder", "starcoder"],
  math: ["math", "deepseek-r1", "qwq", "reasoning", "o1", "phi-4-reasoning"],
  chat: [], // no special-casing — provider defaults are already tuned for general chat
};

/**
 * @param {string} taskType - one of TASK_TYPES, or anything else (treated as no-op)
 * @param {string[]} candidates - the provider's ordered model-fallback candidate list
 * @returns {string[]} reordered candidate list (same elements, new order)
 */
export function applyTaskRouting(taskType, candidates) {
  const hints = TASK_MODEL_HINTS[taskType];
  if (!hints?.length || !candidates?.length) return candidates;

  const scored = candidates.map((model, i) => {
    const lower = model.toLowerCase();
    const hintIndex = hints.findIndex((h) => lower.includes(h));
    // Lower score = better match (found earlier in the hints list); models
    // with no match get a score that keeps their relative original order.
    const score = hintIndex === -1 ? hints.length + i : hintIndex;
    return { model, i, score };
  });

  scored.sort((a, b) => a.score - b.score || a.i - b.i);
  return scored.map((s) => s.model);
}
