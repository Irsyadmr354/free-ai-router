# free-ai-router — Roadmap

Status implementasi semua fitur yang pernah diidentifikasi.
Update terakhir: 2025-07-06 (setelah v5.0.0).

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

### v5.0.0
- ✅ Circuit breaker (CLOSED/OPEN/HALF_OPEN per provider)
- ✅ Request queue (hold request saat semua provider unavailable)
- ✅ Auto-discover OpenRouter free models (live sync dari API, 25+ model)
- ✅ Groq CHAT_MODELS whitelist (pisah chat model dari Whisper/STT/TTS)
- ✅ Fix tool-calling bugs (Gemini $schema, Groq 128-tool cap)
- ✅ Fix opencode.json model ID

---

## Backlog — Belum diimplementasi

### 🔴 High priority

| # | Fitur | Deskripsi |
|---|---|---|
| 1 | **`.gitattributes`** | `* text=auto eol=lf` — fix LF/CRLF warning di setiap commit. 5 menit, fix selamanya. |
| 2 | **`FAIL_ON_INVALID_KEY`** | Env var: kalau aktif dan semua key fail auth di startup, server exit dengan error jelas daripada diam-diam berjalan tanpa provider. |
| 3 | **`/v1/health` yang lebih informatif** | Tambah: uptime, total requests served, cache hit rate, queue depth, circuit states — jadi monitoring endpoint yang serius. |
| 4 | **Automatic stale key detection** | Startup health check sudah log ❌ untuk auth failure. Tambah warning yang lebih eksplisit: "GEMINI_API_KEY appears expired or revoked — remove or replace it" daripada generic error. |

### 🟡 Medium priority

| # | Fitur | Deskripsi |
|---|---|---|
| 5 | **Per-provider retry budget** | `MAX_RETRIES_PER_PROVIDER=2` — batasi berapa model dalam satu provider yang boleh dicoba sebelum langsung lompat ke provider berikutnya. |
| 6 | **Webhook saat provider pulih** | Discord notif bukan hanya saat semua gagal, tapi juga saat provider pulih setelah circuit breaker half-open probe berhasil. |
| 7 | **`tools` di `compare_providers`** | Sekarang `compare_providers` tidak support tool calling. Tambah parameter `tools` untuk evaluasi tool calling antar provider. |
| 8 | **Automatic model deprecation detection** | Kalau setelah sync ulang jumlah free model OpenRouter turun signifikan (>20%), log warning + Discord notif. |
| 9 | **`npm run check` script** | `node --check` semua `.js` files sekaligus. Bisa jadi pre-commit hook lokal. |

### 🟢 Nice to have

| # | Fitur | Deskripsi |
|---|---|---|
| 10 | **`show_all_models` parameter di `list_providers`** | Default hanya tampilkan chat-capable models, bukan full catalog termasuk Whisper dll. |
| 11 | **`get_server_health` MCP tool** | Sama dengan `/v1/health` tapi accessible via MCP tool — uptime, requests, cache, queue, circuit states. |
| 12 | **OpenAPI spec** | `openapi.yaml` untuk `http-server.js` — IDE autocomplete, Postman/Insomnia import. |
| 13 | **`npx`-able** | Publish ke npm, orang bisa langsung `npx free-ai-router`. |
| 14 | **Vercel AI SDK compatibility** | `x-vercel-ai-data-stream` header support di HTTP proxy. |
| 15 | **Semantic model routing** | `task_type: "code" | "chat" | "math"` parameter — route otomatis ke model yang paling cocok untuk task tersebut. |
| 16 | **Per-provider streaming timeout** | Timeout terpisah untuk streaming vs non-streaming — streaming butuh toleransi lebih lama untuk first chunk. |

---

## Dihapus / Dibatalkan

| Fitur | Alasan |
|---|---|
| SambaNova provider | $5 kredit expired 3 bulan → pay-per-use |
| Together AI provider | Free tier dihapus |
| GitHub Actions CI | Account billing lock — tidak bisa jalan di repo ini |

---

*Last updated: 2025-07-06 (v5.0.0)*
