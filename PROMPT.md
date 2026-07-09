# PROMPT FOR AI AGENT — Implementing Token Saving Proxy in free-ai-router

Copy the entire content below and give it to an AI coding agent (Claude Code, etc.) that has access to the `free-ai-router` project directory.

---

## START PROMPT

You are working on the `free-ai-router` project (an MCP server + OpenAI-compatible HTTP proxy that routes chat completions to 7 free LLM providers with automatic fallback). Your task: **add a Token Saving module** — a powerful but safe input/output token-reduction system (must not cause hallucination or loss of meaning).

First read `ROADMAP.md`, `lib/router-core.js`, `lib/config.js`, `index.js`, and `http-server.js` to understand the existing architecture before changing anything. This feature MUST integrate with the `executeProviderChain()` flow in `lib/router-core.js`, and be used by BOTH entry points (`index.js` MCP and `http-server.js` HTTP proxy) — not implemented twice separately.

### Mandatory design principles (do not violate)

1. **Tier hierarchy based on hallucination risk** — implement exactly these 4 tiers:
   - **Tier 0** (always ON, 0% risk): purely deterministic, provably reversible
   - **Tier 1** (default ON, ~0% risk): deterministic + heuristic, but MUST be transparent when data is trimmed
   - **Tier 2** (opt-in via parameter, low risk): controlled lossy, ROI must be calculated before applying
   - **Tier 3** (explicit opt-in + mandatory warning in response, medium-high risk): uses an LLM to summarize, default OFF

2. **Mandatory transparency** — every response (from either the MCP tool or the HTTP proxy) must include honest metadata about what happened: how many tokens were saved, which technique was used, whether any context was trimmed/lost, and an explicit warning for lossy operations. **STRICTLY FORBIDDEN**: silent data loss — this was a critical bug in another internal project (`tokesave-mcp`) that must be avoided here.

3. **Execution priority order**: cache/dedup first (highest ROI, 100% savings on a hit) → then compression (20-50% savings) → then lossy options only if explicitly requested. Don't waste compute on compression if there's a cache hit.

4. **All lossy techniques must calculate ROI before applying** — if the metadata/legend overhead costs more than what's saved, automatically skip that technique and report in the metadata that it was skipped because it wasn't beneficial.

---

### File structure to create

Create a new module at `lib/token-saver.js` with the following functions. Follow the existing code style in this project (full JSDoc on every function, configuration via env vars with getters in `lib/config.js`, error handling that never throws for optional operations).

#### TIER 0 — Purely deterministic (always active, no flag needed)

**1. `minifyStructuredContent(text, contentType)`**

- Detect whether the `context` or part of the prompt contains code (JS/TS/JSON/CSS/HTML) based on simple heuristics (markdown fences ` ```js `, mentioned file extensions, etc.) or an explicit parameter.
- For JS/TS: use the `terser` library (add as a dependency in `package.json`) for AST-based minification — NOT regex. If parsing fails (not valid code), return the original text without error, just log a warning.
- For JSON: `JSON.stringify(JSON.parse(text))` with no indentation — if parsing fails, return the original.
- For CSS: implement a simple minifier yourself (strip `/* */` comments, excess whitespace) or add `csso`/`clean-css` as a lightweight dependency — pick whichever has the lightest dependency footprint.
- Return `{ text: minifiedText, originalTokenEstimate, minifiedTokenEstimate, applied: boolean }`.

**2. `normalizeWhitespace(text)`**

- Remove trailing whitespace per line.
- Compress 3+ consecutive blank lines down to a maximum of 1 blank line.
- Remove double spaces within sentences (but not inside code blocks — detect whether the text contains a code block and skip that part).
- This ALWAYS runs, no flag needed, since the risk is zero.

**3. Cache & dedup** — this project ALREADY has `lib/cache.js` and `lib/dedup.js`. DO NOT recreate them. Make sure token-saver integrates AFTER the cache check in `executeProviderChain()`, not before or in place of it.

#### TIER 1 — Deterministic + heuristic (default ON, can be disabled via env var)

**4. `trimContextWindow(messages, options)`**

- Strategy: always fully preserve messages with `role: "system"`, always preserve the last `N` messages (default `N=10`, configurable via `CONTEXT_TRIM_KEEP_RECENT`), only trim older messages in between when the total estimated token count exceeds `CONTEXT_TRIM_THRESHOLD_TOKENS` (default 8000, configurable).
- MUST return metadata: `{ messages: trimmedArray, trimmed: boolean, messagesDropped: number, droppedTurnRange: string }` — this is used for transparency to the user, DO NOT discard this information.
- Never trim the last user message (the one currently being asked) — that would break the request.

**5. `deduplicateRepeatedBlocks(messages)`**

- Detect if there are identical text blocks (exact string match, not semantic) that appear in more than one message within the `messages[]` array — e.g., a user pastes the same document twice in two different turns.
- Replace the second and subsequent occurrences with a short reference: `[content identical to a previous message — see reference #N]` and insert a brief explanation in the system prompt that this reference is valid.
- Minimum threshold: only process blocks longer than `DEDUP_MIN_BLOCK_CHARS` (default 200 characters) so short sentences that happen to match aren't processed needlessly.

**6. Auto-stop on streaming** — modify `lib/sse-forward.js` or `lib/router-core.js` (whichever is more appropriate after you read the code) to detect when the model has clearly finished its answer (e.g., a closed code block followed by no new tokens for N ms, or a `[DONE]`-equivalent token) and consider early-stopping — BUT this is optional and risks cutting off an unfinished answer, so provide an explicit flag `EARLY_STOP_ENABLED=false` (default OFF) for this feature since its risk is higher than other Tier 1 items. If you feel the implementation is too risky, skip this feature and just document in the code why it was skipped.

#### TIER 2 — Controlled lossy (opt-in via per-request parameter)

**7. `compactStructuredData(text)`**

- Detect tabular data expressed as repetitive narrative sentences (patterns like "Row 1: column A is X, column B is Y. Row 2: ...") and offer conversion to compact CSV/TSV.
- MUST be opt-in via parameter, since this pattern detection is heuristic and can misfire on text that happens to look similar.
- Return `{ text, applied, savingsEstimate }`.

**8. `applyAbbreviationDictionary(text, dictionary, options)`**

- Accept an abbreviation dictionary (can reuse ones previously built in another project — ID/JP/EN — or default to empty and let the user supply their own via parameter).
- MUST first calculate: is `estimateTokens(legend) + estimateTokens(compactedText) < estimateTokens(originalText)`? If not, skip and report `applied: false, reason: "overhead is more expensive than the savings"`.
- If applied, MUST insert the abbreviation legend/definitions into the `system_prompt` sent to the model — NEVER send abbreviations without explicit definitions to the model, since that is a primary cause of model misinterpretation/hallucination.
- Return `{ text, legend, systemPromptAddition, applied, tokensSaved }`.

#### TIER 3 — LLM-based summarization (explicit opt-in, mandatory warning)

**9. `summarizeContextViaLLM(text, options)`**

- Only called when the caller explicitly sets the parameter `allow_lossy_summarization: true` AND the context exceeds a hard limit (`SUMMARIZATION_TRIGGER_TOKENS`, default 50000, configurable).
- Use the chat completion provider that ALREADY EXISTS in `lib/router-core.js` (call `executeProviderChain` with a cheap/fast model, don't make a separate API call) with a system prompt that explicitly requests: "Summarize the following text WITHOUT omitting numbers, names, dates, decisions, or important technical details. Focus on condensing narrative explanation, not discarding facts."
- MUST return `{ summary, warning: "Summary was auto-generated by an LLM — details may be lost or altered, manual verification recommended", originalTokens, summarizedTokens }`.
- MUST log to stderr every time this function is called (using the existing `lib/logger.js`) since this is the riskiest operation in the entire module.

---

### Integration into `lib/config.js`

Add the following getters following the existing pattern in that file (first read other example getters like `isModelFallbackEnabled()`, `getMaxTokensCap()` for style consistency):

```
isTokenSavingEnabled()              → env TOKEN_SAVING_ENABLED, default true
getContextTrimKeepRecent()          → env CONTEXT_TRIM_KEEP_RECENT, default 10
getContextTrimThresholdTokens()     → env CONTEXT_TRIM_THRESHOLD_TOKENS, default 8000
getDedupMinBlockChars()             → env DEDUP_MIN_BLOCK_CHARS, default 200
isStructuralMinifyEnabled()         → env STRUCTURAL_MINIFY_ENABLED, default true
getSummarizationTriggerTokens()     → env SUMMARIZATION_TRIGGER_TOKENS, default 50000
```

Add validation for these new numeric env vars to the existing `validateConfig()` function (there's a `numericVars` array there — add the new env var names to it).

### Integration into `lib/router-core.js`

Inside `executeProviderChain()`, AFTER the cache check (which happens in `index.js`/`http-server.js` before calling this function) and BEFORE the `for (const providerName of order)` loop, call the token-saver pipeline in sequence according to the tiers above. Store the token-saving metadata result in a variable and attach it to `result._meta` (this field already exists in the code — follow the existing `_meta` pattern used for `fallbackModel`, `cappedNote`, etc.).

### Integration into `index.js` (MCP tool)

Add new parameters to the `chat_completion` tool (follow the existing Zod schema pattern used for other parameters in that file):

```
allow_lossy_summarization: z.boolean().optional().default(false)
abbreviation_dictionary: z.record(z.string()).optional()
show_token_savings: z.boolean().optional().default(false) — if true, display savings metadata in the response text
```

Also create a new MCP tool `get_token_savings_report` that displays aggregate token-savings statistics for the current session (similar to the existing `get_benchmarks` or `get_reputation` pattern in that file — follow the existing tool-writing style for consistency).

### Integration into `http-server.js`

Add the same fields (`allow_lossy_summarization`, `abbreviation_dictionary`) to the `POST /v1/chat/completions` request body, and include the token-saving metadata in a non-standard response field `x_token_savings` (using the `x_` prefix since this is not part of the official OpenAI spec, to avoid conflicting with clients that strictly validate the OpenAI schema).

### Mandatory testing & validation before completion

1. Run `npm run check` (the existing script in this project) to make sure all new files pass `node --check`.
2. Write manual test examples in the existing `test-call.js` (read it first to follow the existing pattern) for at least 3 scenarios: (a) short context — all tier 0/1 run without changing meaning, (b) long context with old messages — verify trimming reports metadata correctly, (c) abbreviation dictionary — verify the ROI check works (skips when not beneficial).
3. Update `README.md` and `ROADMAP.md` to document this new feature following the existing format in both files (Indonesian for ROADMAP.md, following the existing writing style).
4. Update `.env.example` with all new env vars added, following the existing comment/explanation format in that file.
5. Bump the version in `package.json` according to semantic versioning (new feature = minor bump).

### Hard constraints — DO NOT DO THIS

- DO NOT implement Tier 2/Tier 3 as enabled by default — they must always be explicit opt-in.
- NEVER send abbreviations/symbols to the model without an explicit definition in the system prompt.
- NEVER silently drop context without reporting it in the response metadata.
- DO NOT recreate the existing cache/dedup — use the existing `lib/cache.js` and `lib/dedup.js`.
- DO NOT use regex for code minification — use a real AST parser (terser for JS/TS).
- DO NOT add heavy dependencies (avoid large frameworks) — this project is intentionally zero-dependency aside from `@modelcontextprotocol/sdk`, `dotenv`, and now `terser`/`csso` (pick the lightest one).

When finished, report a short summary at the end: which features were implemented, which files were changed/created, and the average estimated token savings for each tier based on the manual testing you performed.

## END PROMPT
