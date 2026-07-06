    # free-ai-router — Roadmap & Feature Backlog

Semua fitur di bawah ini sudah diidentifikasi dan di-keep untuk implementasi berikutnya.
Diurutkan per batch dan prioritas dalam setiap batch.

---

## Batch 1 — Nice to Have (sudah diimplementasi ✅)

- ✅ `npx`-able / publish ke npm
- ✅ Dockerfile
- ✅ Tool `clear_cache`
- ✅ Per-call `no_cache: true` parameter

---

## Batch 2 — Yang Langsung Berguna

| # | Fitur | Prioritas | Deskripsi |
|---|---|---|---|
| 1 | **Streaming support** | 🔴 High | Output muncul kata per kata — jauh lebih responsif untuk prompt panjang. Semua 7 provider support ini. |
| 2 | **Image input (multimodal)** | 🔴 High | Tambah parameter `image_url` atau `image_base64` di `chat_completion`. Gemini 2.5 Flash support analisis gambar/screenshot/diagram. |
| 3 | **Automatic model fallback dalam satu provider** | 🔴 High | Sebelum pindah ke provider lain, coba model alternatif dalam provider yang sama. Misal: `gemini-2.5-flash` gagal → coba `gemini-1.5-flash` dulu. |

---

## Batch 3 — Memperkuat Project

| # | Fitur | Prioritas | Deskripsi |
|---|---|---|---|
| 4 | **Request deduplication** | 🟡 Medium | Dua request identik yang datang bersamaan share satu provider call — request kedua nunggu hasil request pertama. |
| 5 | **`chat_completion` dengan `context` parameter** | 🟡 Medium | Parameter `context` berupa dokumen/codebase panjang yang otomatis di-chunk kalau melebihi token limit provider. |
| 6 | **Rate limit budget tracker** | 🟡 Medium | Track jumlah request per provider hari ini vs limit free tier yang diketahui. Auto-deprioritize provider yang sudah mendekati 90% limit sebelum kena 429. |
| 7 | **Web dashboard** | 🟢 Nice | Server Express kecil di port terpisah — tampilkan provider status, usage stats, dan log secara realtime lewat browser. |
| 8 | **Tool `compare_providers`** | 🟢 Nice | Kirim prompt yang sama ke semua provider sekaligus, tampilkan semua response dan latency side-by-side untuk evaluasi kualitas model. |
| 9 | **Structured output / JSON mode** | 🟢 Nice | Parameter `response_format: "json"` — Groq, OpenRouter, Gemini support JSON mode natively. Berguna untuk AI agent yang butuh output terstruktur. |

---

## Batch 4 — Fitur Lanjutan

| # | Fitur | Prioritas | Deskripsi |
|---|---|---|---|
| 10 | **Tool calling / function calling passthrough** | 🔴 High | Forward parameter `tools` ke provider yang support (Groq, Gemini, OpenRouter, Mistral) — AI agent bisa pakai LLM eksternal untuk function calling. |
| 11 | **Automatic provider benchmarking** | 🔴 High | Catat latency setiap call ke log. Tool `get_benchmarks` tampilkan rata-rata latency per provider — bisa auto-sort provider order berdasarkan performa aktual. |
| 12 | **Prompt template system** | 🔴 High | Tool `chat_with_template` dengan parameter `template_name` — load template dari `./templates/*.md`. Untuk prompt yang sering dipakai (code review, summarize, translate). |
| 13 | **Per-provider max_tokens cap** | 🟡 Medium | Auto-clamp `max_tokens` sesuai batas tiap provider sebelum dikirim — prevent silent error kalau user minta token lebih dari yang provider support. |
| 14 | **MCP Resources** | 🟢 Nice | Expose `usage-log.jsonl` dan `cooldown-state.json` sebagai MCP Resources yang bisa dibaca langsung oleh client tanpa tool call. |
| 15 | **Provider aliases** | 🟢 Nice | Set alias di `.env` (`ALIAS_FAST=groq`, `ALIAS_SMART=gemini`) — pakai `providers: ["fast"]` di chat_completion untuk lebih semantic. |
| 16 | **OpenTelemetry tracing** | 🟢 Nice | Export trace setiap provider call ke Jaeger atau console dalam format standar — latency, token count, success/fail. |
| 17 | **Automatic failover testing mode** | 🟢 Nice | Env `SIMULATE_FAILURES=gemini,groq` — provider disebutkan selalu throw 429 tanpa real API call. Untuk test fallback chain tanpa buang quota. |
| 18 | **`summarize_usage_log` tool** | 🟢 Nice | Aggregate `usage-log.jsonl` per hari/minggu — provider paling sering dipakai, jam peak, total token per minggu. |

---

## Batch 5 — Intelligence & UX

| # | Fitur | Prioritas | Deskripsi |
|---|---|---|---|
| 19 | **Provider-specific system prompt injection** | 🔴 High | Env `SYSTEM_INJECT_GROQ=...`, `SYSTEM_INJECT_CLOUDFLARE=...` — inject system prompt tambahan per provider untuk normalize perilaku antar model. |
| 20 | **Fallback reason transparency** | 🔴 High | Parameter `verbose: true` di `chat_completion` — append footnote ke response yang jelaskan kenapa provider di-skip dan siapa yang akhirnya jawab. |
| 21 | **Smart retry untuk network errors** | 🔴 High | Untuk error `null` status (network timeout), retry 1x dengan delay 1s di provider yang sama sebelum fallback — karena timeout sesekali itu normal. |
| 22 | **Input sanitization** | 🟡 Medium | Strip null bytes, limit prompt ke 32k chars, optionally redact pola yang mirip API key di dalam prompt sebelum dikirim ke provider. |
| 23 | **Provider warm-up pool** | 🟡 Medium | Background ping setiap 5 menit ke provider yang dikonfigurasi — prevent cold start penalty di request pertama user. |
| 24 | **Response quality scoring** | 🟡 Medium | Scoring otomatis setelah dapat response: cek apakah terlalu pendek, apakah isinya error message yang lolos (misal "I cannot help with that"). Kalau gagal threshold — coba provider berikutnya meski status 200. |
| 25 | **Multi-language system prompt** | 🟡 Medium | Auto-detect bahasa prompt user, inject system prompt dalam bahasa yang sama untuk hasil yang lebih natural. |
| 26 | **`translate` tool** | 🟢 Nice | Wrapper `chat_completion` dengan system prompt translate yang sudah di-tune. Parameter: `text`, `from`, `to`. Gratis tanpa DeepL/Google Translate API. |
| 27 | **`summarize` tool** | 🟢 Nice | Wrapper dengan system prompt summarize yang dioptimasi. Parameter: `text`, `style` (bullet/paragraph/tldr), `max_words`. |
| 28 | **`code_review` tool** | 🟢 Nice | Wrapper dengan system prompt code review. Parameter: `code`, `language`, `focus` (security/performance/readability). |
| 29 | **Session ID tracking** | 🟢 Nice | Parameter `session_id` di `chat_completion` — group semua call dengan ID yang sama di log untuk lihat token usage per conversation. |
| 30 | **Config validation on startup** | 🟡 Medium | Validasi semua env vars saat start — format API key, typo di PROVIDER_ORDER, validitas DISCORD_WEBHOOK_URL. Log warning yang jelas sebelum error saat runtime. |
| 31 | **`export_usage_report` tool** | 🟢 Nice | Generate laporan Markdown/CSV dari `usage-log.jsonl` — total token, cost estimate, trend per hari. Bisa langsung di-paste ke Notion/Obsidian. |

---

## Batch 6 — Intelligent Adaptive Router (Flagship)

| # | Fitur | Prioritas | Deskripsi |
|---|---|---|---|
| 32 | **Provider reputation system** | 🔴 High | Setiap provider punya reputation score (0–100) yang update otomatis berdasarkan response time, error rate, dan 429 history. Fallback order di-reorder dinamis berdasarkan score — provider paling reliable hari ini selalu dicoba pertama tanpa perlu manual config. |

> Ini yang paling membedakan free-ai-router dari sekedar "router sederhana" menjadi **intelligent adaptive router**.

---

## Summary

| Kategori | Jumlah fitur |
|---|---|
| 🔴 High priority | 11 |
| 🟡 Medium priority | 10 |
| 🟢 Nice to have | 11 |
| **Total** | **32** |

---

*Last updated: 2025-07-06*
