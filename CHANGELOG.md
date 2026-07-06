# Changelog

All notable changes to free-ai-router are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added
- `.gitattributes` — `* text=auto eol=lf` to stop LF/CRLF warnings on every commit.
- `FAIL_ON_INVALID_KEY` env var — when `true`, the server exits at startup if any configured provider's key fails auth (401/403) at the startup health check, instead of silently continuing with a degraded provider chain.
- Explicit stale-key messaging in the startup health check — 401/403 responses now log `"<PROVIDER>_API_KEY appears expired or revoked (HTTP <status>) — remove or replace it in .env"` instead of a generic error.
- `/v1/health` now reports: `uptimeSeconds`, `requests` (total + per-endpoint counters), `cache` (size/enabled/hits/misses/hitRate), `queueDepth`, and `circuits` (per-provider circuit breaker state).
- Cache hit/miss counters in `lib/cache.js` (`cacheStats()` now returns `hits`, `misses`, `hitRate`), feeding the new `/v1/health` reporting.

### Planned
- Stale Discord notification when a provider recovers from circuit-open
- `npm run check` syntax-check script
- `compare_providers` tool: add `tools` parameter support
- Automatic model deprecation detection (alert when OpenRouter free model count drops)

---

## [v5.0.0] — 2025-07-06

### Added
- **Circuit breaker** (`lib/circuit-breaker.js`) — CLOSED/OPEN/HALF_OPEN pattern per provider. Opens after 5 consecutive non-429 failures within 2 minutes, blocks for 5 minutes, then allows one probe request. Separate from cooldown (which handles 429 only). Configurable via `CIRCUIT_BREAKER_ENABLED`, `CIRCUIT_FAILURE_THRESHOLD`, `CIRCUIT_WINDOW_MS`, `CIRCUIT_RECOVERY_MS`.
- **Request queue** (`lib/request-queue.js`) — when ALL providers are on cooldown or circuit-open, requests are held up to 30s waiting for the soonest provider to recover, then retried automatically. Configurable via `REQUEST_QUEUE_ENABLED`, `REQUEST_QUEUE_TIMEOUT_MS`, `REQUEST_QUEUE_MAX_SIZE`.
- **Auto-discover OpenRouter free models** — `syncFreeModels()` fetches `openrouter.ai/api/v1/models` at startup and filters to `pricing.prompt === "0"` models. Synced 25 free models on first run. No auth required. Falls back to hardcoded list if unreachable.
- **Groq CHAT_MODELS whitelist** — exported `CHAT_MODELS` array (10 chat-capable models) separate from `SUPPORTED_MODELS` (full catalog including Whisper STT, prompt-guard classifiers, Orpheus TTS). The fallback chain now uses `chatModels` so non-chat models are never tried for a `chat_completion` request.
- `list_providers` now shows circuit breaker state (`circuit-open (Ns)`) and request queue depth.

### Fixed
- Gemini tool-calling: strip `$schema`, `$ref`, `additionalProperties`, and any `$`-prefixed fields from tool parameter schemas before sending to Gemini API (HTTP 400 fix).
- Groq/Mistral tool-calling: cap `tools` array to provider hard limits (Groq: 128, Mistral: 64) before sending (HTTP 400 fix).
- `opencode.json`: changed model ID from invalid `"free-ai-router"` to `"openrouter/free"` (OpenRouter was rejecting calls with "not a valid model ID").

---

## [v4.0.0] — 2025-07-06

### Added
- **HTTP proxy** (`http-server.js`) — OpenAI-compatible server on `localhost:8787`. Any tool supporting a custom "OpenAI API base URL" can point at `http://localhost:8787/v1` to use free-ai-router as its model backend. Endpoints: `POST /v1/chat/completions`, `GET /v1/models`, `GET /v1/health`.
- **Streaming** — real per-chunk SSE forwarding via `streamFn` on all providers that support it (Groq, OpenRouter, Mistral, SambaNova, Cohere). Gemini uses `streamGenerateContent?alt=sse`. Time-to-first-chunk measured and reported.
- **Image input (multimodal)** — `image_url` and `image_base64` parameters in `chat_completion`. Gemini fetches and inlines remote images as base64.
- **Automatic model fallback within a provider** — if the chosen model fails with a retryable error, other models in that provider's list are tried before moving to the next provider. Controlled by `MODEL_FALLBACK_ENABLED`.
- **Tool calling / function calling passthrough** — `tools` and `tool_choice` parameters forwarded to Groq, OpenRouter, Mistral, Gemini. Tool call responses returned as-is.
- **JSON mode** — `response_format: "json"` parameter uses native JSON mode on Groq, OpenRouter, Gemini, Mistral.
- **Per-provider max_tokens cap** — requests above each provider's known limit are silently clamped. Configurable via `MAX_TOKENS_CAP_*` env vars.
- **Budget-aware routing** — tracks requests against known free-tier limits. Providers approaching 90% of daily/monthly budget are deprioritized before they hit a real 429.
- **Provider reputation system** — 0–100 score per provider updated on every call based on latency, success rate, and error type. Fallback order is auto-reordered so the most reliable provider is tried first.
- **Automatic provider benchmarking** — latency and success rate tracked per provider. `get_benchmarks` tool shows average/p95 latency.
- **Structured output / JSON mode** — native JSON mode on Groq, OpenRouter, Gemini, Mistral.
- **Request deduplication** — concurrent identical calls share one in-flight promise.
- **Long-context auto-chunking** — `context` parameter: large documents are chunked at 3000 tokens, processed sequentially, results concatenated.
- **Session ID tracking** — `session_id` parameter groups calls in `usage-log.jsonl`.
- **Verbose fallback transparency** — `verbose: true` appends footnote explaining which providers were skipped and why.
- **Input sanitization** — strip null bytes, limit prompt to 32k chars, optionally redact API key patterns.
- **Provider-specific system prompt injection** — `SYSTEM_INJECT_<PROVIDER>=...` env vars.
- **Multi-language system prompt** — `MULTI_LANGUAGE_SYSTEM_PROMPT=true` auto-detects prompt language and nudges model to reply in kind.
- **Response quality scoring** — `QUALITY_SCORING_ENABLED=true` soft-fails empty/refusal responses and tries next provider.
- **Provider aliases** — `ALIAS_FAST=groq` etc., usable in `providers: ["fast"]`.
- **`SIMULATE_FAILURES` env var** — force-fail specific providers for testing fallback chain.
- **Web dashboard** — `DASHBOARD_ENABLED=true` serves live provider status at configurable port.
- **MCP Resources** — `usage-log.jsonl` and `cooldown-state.json` exposed as MCP resources.
- **OpenTelemetry-style tracing** — `TRACING_ENABLED=true`.
- **Provider warm-up pool** — `PROVIDER_WARMUP_ENABLED=true` pings providers on a background interval.
- **Config validation on startup** — checks for typos in `PROVIDER_ORDER`, whitespace in API keys, missing `CLOUDFLARE_ACCOUNT_ID`, invalid `DISCORD_WEBHOOK_URL`.
- New MCP tools: `clear_cache`, `compare_providers`, `get_benchmarks`, `chat_with_template`, `summarize_usage_log`, `export_usage_report`, `translate`, `summarize`, `code_review`, `get_reputation`.
- `lib/router-core.js` — shared fallback chain logic extracted so both `index.js` (MCP) and `http-server.js` (HTTP) reuse it without duplication.
- `opencode.json` — project-level OpenCode config pointing at HTTP proxy.
- `IDE_SETUP.md` — setup guide for Cursor, Kiro, opencode, Claude Code, etc.
- `Dockerfile` + `.dockerignore` — container support.
- **OpenCode Zen provider** — 5 free models, auto-synced from `opencode.ai/zen/v1/models` at startup.

### Changed
- Version bumped to `4.0.0`.
- Cohere default model updated from deprecated `command-r` to `command-r-plus-08-2024`.

---

## [v3.0.0] — 2025-07-06

### Added
- **GitHub Actions CI** — syntax check + `.env` guard on every push. *(Later removed due to account billing lock.)*
- **Input validation** — `max_tokens` clamped to 1–8192, `temperature` to 0–2, `prompt` must be non-empty.
- **Graceful shutdown** — `SIGINT`, `SIGTERM`, `uncaughtException`, `unhandledRejection` handlers.
- **Startup health check** — auto-pings all configured providers on boot and logs which are ready.
- **Persistent cooldown** (`cooldown-state.json`) — cooldown state survives server restarts.
- **Multi-turn `messages[]`** — `chat_completion` accepts full conversation history.
- **`set_provider_order` tool** — change fallback order at runtime without restarting.
- **Discord webhook** (`lib/notifier.js`) — posts a notification when all providers fail simultaneously.

### Fixed
- Cohere `command-r` model removed September 2025 — updated to `command-r-plus-08-2024`.

---

## [v2.0.0] — 2025-07-06

### Added
- **7 providers** (up from 3): added Cloudflare Workers AI, Together AI *(later replaced by SambaNova, then removed)*, Cohere, Mistral.
- **6 MCP tools** (up from 1): `chat_completion` (enhanced), `list_providers`, `embed_text`, `count_tokens`, `ping_providers`, `get_usage_stats`.
- **Model selector** — `model` parameter in `chat_completion` to override default per provider.
- **Provider order override** — `providers` parameter and `PROVIDER_ORDER` env var.
- **Rate-limit cooldown** — 60-second in-memory cooldown on 429, persisted later in v3.
- **In-memory response cache** (`lib/cache.js`) — 5-minute TTL, configurable.
- **Token usage logging** (`usage-log.jsonl`) — every successful call logged with token counts.
- **Per-provider timeouts** — `TIMEOUT_<PROVIDER>_MS` env vars.
- `lib/config.js`, `lib/cooldown.js`, `lib/cache.js`, `lib/logger.js`, `lib/usage-tracker.js`.
- `lib/normalize.js` — `normalizeSuccess()` and `ProviderError` class.

---

## [v1.0.0] — 2025-07-06

### Added
- Initial release.
- 3 providers: **Gemini** (gemini-2.5-flash), **Groq** (llama-3.3-70b-versatile), **OpenRouter** (openrouter/free).
- 1 MCP tool: `chat_completion` with sequential fallback (Gemini → Groq → OpenRouter).
- 15-second AbortController timeout per provider.
- `ProviderError` with HTTP status for distinguishing 429 from other failures.
- stderr-only logging (stdout reserved for MCP stdio protocol).
- `.env` / `.env.example` / `.gitignore` / `README.md`.
