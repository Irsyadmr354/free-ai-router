import { log, logError } from "./logger.js";
import { getApiKeys } from "./config.js";
import { PROVIDER_REGISTRY, reorderProvidersForPrompt, callWithSmartRetry } from "./router-core.js";

/**
 * Executes a Mixture of Agents (Ensemble) request.
 * It sends the prompt to the top 3 providers in parallel.
 * Then, it sends the 3 results to the #1 ranked provider for synthesis.
 */
export async function executeEnsembleChain(params, options) {
  const { order = Object.keys(PROVIDER_REGISTRY), keys = getApiKeys() } = options;
  const prompt = params.prompt || params.messages?.[params.messages.length - 1]?.content || "";
  
  // Get top 3 healthy providers
  const ranked = reorderProvidersForPrompt(order, prompt, params.systemPrompt);
  const candidates = ranked.filter(p => keys[p] && PROVIDER_REGISTRY[p]);
  
  if (candidates.length < 2) {
    throw new Error("Ensemble requires at least 2 available providers with API keys.");
  }

  const top3 = candidates.slice(0, 3);
  log(`[ensemble] Starting parallel execution across: ${top3.join(", ")}`);

  // Parallel execution
  const promises = top3.map(async (providerName) => {
    const entry = PROVIDER_REGISTRY[providerName];
    const callParams = { 
      ...params, 
      model: entry.defaultModel, 
      apiKey: keys[providerName],
      onDelta: undefined // Do not stream the intermediate steps!
    };
    try {
      log(`[ensemble] Fetching from ${providerName}...`);
      const res = await callWithSmartRetry(entry.fn, callParams, providerName);
      return { provider: providerName, text: res.text, success: true };
    } catch (e) {
      logError(`[ensemble] ${providerName} failed: ${e.message}`);
      return { provider: providerName, text: "", success: false };
    }
  });

  const results = await Promise.all(promises);
  const successfulResults = results.filter(r => r.success);

  if (successfulResults.length === 0) {
    throw new Error("All ensemble providers failed to generate intermediate responses.");
  }

  log(`[ensemble] Synthesis phase: combining ${successfulResults.length} responses.`);

  // Prepare synthesis prompt
  const synthesisPrompt = `
You are an expert synthesizer. You have been provided with answers from ${successfulResults.length} different AI models to the following user query:
<user_query>
${prompt}
</user_query>

Here are the models' responses:
${successfulResults.map((r, i) => `--- Response ${i + 1} (${r.provider}) ---\n${r.text}`).join("\n\n")}

Your task is to synthesize the best possible answer. Combine their strengths, correct any mistakes, and output the final, ultimate response directly without meta-commentary.
`;

  // For the final synthesis, use the #1 provider, and we CAN stream this to the user!
  const synthProvider = candidates[0];
  const synthEntry = PROVIDER_REGISTRY[synthProvider];
  log(`[ensemble] Synthesizing using ${synthProvider}`);

  // Create new params for the final call
  const synthParams = {
    ...params,
    model: synthEntry.defaultModel,
    apiKey: keys[synthProvider],
    prompt: synthesisPrompt,
    messages: undefined // Override messages with the direct synthesis prompt
  };

  const useStreaming = Boolean(options.onDelta) && synthEntry.supportsStream && typeof synthEntry.streamFn === "function";
  const fnToUse = useStreaming ? synthEntry.streamFn : synthEntry.fn;

  if (useStreaming) {
    synthParams.onDelta = options.onDelta;
    if (options.abortSignal) synthParams.abortSignal = options.abortSignal;
  }

  const finalRes = await callWithSmartRetry(fnToUse, synthParams, synthProvider);
  return {
    ...finalRes,
    provider: `${synthProvider} (Ensemble Synthesizer)`,
    model: synthEntry.defaultModel
  };
}
