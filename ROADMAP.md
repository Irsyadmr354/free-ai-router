# free-ai-router — Roadmap

Status implementasi semua fitur yang pernah diidentifikasi.
Update terakhir: 2026-07-06 (setelah v5.1.0 — audit menyeluruh + backlog lengkap).

---

## Sudah diimplementasi ✅

### Core (v1.0.0)
- ✅ 3 provider free: Gemini, Groq, OpenRouter
- ✅ Sequential fallback chain
- ✅ `ProviderError` dengan HTTP status (bisa bedain 429 vs error lain)
- ✅ Stderr-only logging

### v2.0.0
- ✅ 7 provider (tambah Cloudflare, Cohere, Mistral, OpenCode Zen)
- ✅ 6 MCP tools
- ✅ Model selector per call
- ✅ Provider order override (env + parameter)
- ✅ Rate-limit cooldown (429 → 60s cooldown)
- ✅ In-memory response cache (5min TTL)
- ✅ Token usage logging (`usage-log.jsonl`)
- ✅ Per-provider timeout config

### v3.0.0
- ✅ Graceful shutdown (SIGINT/SIGTERM/uncaughtException)
- ✅ Startup health check — auto-ping semua provider on boot
- ✅ Persistent cooldown (survive restart)
- ✅ Multi-turn `messages[]` support
- ✅ `set_provider_order` tool (runtime, no restart needed)
- ✅ Discord webhook saat semua provider fail
- ✅ Input validation (max_tokens, temperature, prompt)
- ✅ Config validation on startup

### v4.0.0
- ✅ HTTP proxy (`http-server.js`) — OpenAI-compatible endpoint
- ✅ Streaming (real SSE forwarding)
- ✅ Image input / multimodal (Gemini)
- ✅ Model fallback dalam satu provider sebelum pindah ke provider lain
- ✅ Tool calling / function calling passthrough
- ✅ JSON mode / structured output
- ✅ Per-provider max_tokens cap (auto-clamp)
- ✅ Budget-aware routing (deprioritize provider mendekati free limit)
- ✅ Provider reputation system (0–100 score, auto-reorder)
- ✅ Automatic provider benchmarking (latency/p95)
- ✅ Request deduplication (concurrent identical calls share one promise)
- ✅ Long-context auto-chunking via `context` parameter
- ✅ Session ID tracking
- ✅ Verbose fallback transparency (`verbose: true`)
- ✅ Input sanitization (null bytes, API key redaction, 32k char limit)
- ✅ Provider-specific system prompt injection
- ✅ Multi-language system prompt auto-detect
- ✅ Response quality scoring (soft-fail empty/refusal responses)
- ✅ Provider aliases (`ALIAS_FAST=groq`)
- ✅ `SIMULATE_FAILURES` test hook
- ✅ Web dashboard (`DASHBOARD_ENABLED=true`)
- ✅ MCP Resources (usage-log + cooldown-state)
- ✅ OpenTelemetry-style tracing
- ✅ Provider warm-up pool
- ✅ 10 tool baru: `clear_cache`, `compare_providers`, `get_benchmarks`, `chat_with_template`, `summarize_usage_log`, `export_usage_report`, `translate`, `summarize`, `code_review`, `get_reputation`
- ✅ Cohere model fix (command-r → command-r-plus-08-2024)
- ✅ SambaNova dihapus (tidak genuinely free)
- ✅ OpenCode Zen provider dengan auto-sync model

### v7.0.0 — Advanced Routing Architecture
- ✅ **Model Ensembling (Mixture of Agents)** — `model: "ensemble"` queries top 3 providers in parallel, synthesizes the best answer via a 4th
- ✅ **Universal Tool Calling Polyfill** — providers without native tool support get tools injected as structured system prompts, with `<tool_call>` XML parsing on output
- ✅ **Hot-Swap Streaming Fallback** — if a stream dies mid-response, the next provider picks up exactly where it left off (no restart from scratch)
- ✅ **Local Auto-RAG** — prompts >20k tokens are automatically chunked, embedded locally via `all-MiniLM-L6-v2`, and only the most relevant chunks are sent to the API
- ✅ **JS/TS AST minification** — Tier 0 now minifies JavaScript/TypeScript code blocks via `terser`
- ✅ `@xenova/transformers` dependency for local embedding
- ✅ `ensemble` virtual model exposed in `/v1/models` endpoint

### v5.2.0
- ✅ Token Saving module (`lib/token-saver.js`) — 4-tier pipeline
- ✅ Tier 0: `normalizeWhitespace()`, `minifyStructuredContent()` (JSON/CSS)
- ✅ Tier 1: `trimContextWindow()`, `deduplicateRepeatedBlocks()`
- ✅ Tier 2: `applyAbbreviationDictionary()` (ROI-checked, legend auto-injected), `compactStructuredData()`
- ✅ Tier 3: `summarizeContextViaLLM()` (opt-in explicit, warning mandatory, always logged)
- ✅ `get_token_savings_report` MCP tool
- ✅ `chat_completion`: `allow_lossy_summarization`, `abbreviation_dictionary`, `show_token_savings` params
- ✅ HTTP proxy: `x_token_savings` field in non-streaming response
- ✅ 6 new config getters + numeric validation in `validateConfig()`

### v5.1.0
- ✅ `.gitattributes` — consistent LF line endings
- ✅ `openapi.yaml` — OpenAPI spec for `http-server.js`
- ✅ `scripts/check-syntax.js` + `npm run check`
- ✅ `lib/task-routing.js` — semantic model routing by task type
- ✅ `get_server_health` MCP tool
- ✅ `show_all_models` parameter in `list_providers`
- ✅ Per-provider streaming timeout (`STREAM_TIMEOUT_*_MS`)
- ✅ `MAX_RETRIES_PER_PROVIDER` config
- ✅ Request queue (hold request saat semua provider unavailable)
- ✅ Auto-discover OpenRouter free models (live sync dari API, 25+ model)
- ✅ Groq CHAT_MODELS whitelist (pisah chat model dari Whisper/STT/TTS)
- ✅ Fix tool-calling bugs (Gemini $schema, Groq 128-tool cap)
- ✅ Fix opencode.json model ID

### v5.1.0 (backlog lengkap diselesaikan)
- ✅ **`MAX_RETRIES_PER_PROVIDER`** — batasi berapa model dalam satu provider yang dicoba sebelum lompat ke provider berikutnya.
- ✅ **Webhook saat provider pulih** — Discord notif saat circuit breaker HALF_OPEN probe berhasil (kembali ke CLOSED), terpisah dari notif "semua gagal".
- ✅ **`tools` di `compare_providers`** — evaluasi tool calling antar provider side-by-side, provider tanpa dukungan tools di-skip dengan catatan.
- ✅ **Automatic model deprecation detection** — warning + Discord notif kalau jumlah free model OpenRouter turun >20% setelah resync.
- ✅ **`npm run check`** — `node --check` semua `.js` file via `scripts/check-syntax.js`, bisa jadi pre-commit hook lokal.
- ✅ **`show_all_models` di `list_providers`** — default hanya chat-capable models, `show_all_models: true` untuk full catalog.
- ✅ **`get_server_health` MCP tool** — uptime, cache, queue, circuit breaker states, setara `/v1/health` tapi via MCP.
- ✅ **`openapi.yaml`** — spec lengkap untuk `http-server.js`, siap untuk IDE autocomplete / Postman / Insomnia import.
- ✅ **`npx`-able** — `package.json` diperbarui (bin ganda, publishConfig, repository, keywords) siap `npm publish`.
- ✅ **Vercel AI SDK compatibility** — `x-vercel-ai-data-stream` response header saat diminta via header/query param.
- ✅ **Semantic model routing** — `task_type: "code" | "chat" | "math"` parameter di `chat_completion`, reorder model candidates dalam provider berdasarkan heuristik nama model.
- ✅ **Per-provider streaming timeout** — `getStreamTimeout()` terpisah dari timeout non-streaming, default 2x lipat (bisa dikonfigurasi), diterapkan ke semua provider streaming (Groq, OpenRouter, Cohere, Mistral, OpenCode Zen).

---

## Backlog — Belum diimplementasi

Semua item backlog sebelumnya sudah diimplementasi per v5.2.0.
Item baru dari audit selanjutnya akan ditambahkan di sini.

---

## Dihapus / Dibatalkan

| Fitur | Alasan |
|---|---|
| SambaNova provider | $5 kredit expired 3 bulan → pay-per-use |
| Together AI provider | Free tier dihapus |
| GitHub Actions CI | Account billing lock — tidak bisa jalan di repo ini |

---

*Last updated: 2025-07-06 (v5.2.0)*
