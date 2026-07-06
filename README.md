# free-ai-router

> An stdio MCP server + OpenAI-compatible HTTP proxy that routes requests across **7 free-tier LLM providers** with automatic fallback, circuit breaker, cooldown tracking, request queuing, response caching, and usage logging — so you never hit a hard stop when one provider's free quota runs out.

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![MCP SDK](https://img.shields.io/badge/@modelcontextprotocol%2Fsdk-1.29.0-blue)](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

---

## How it works

When you call `chat_completion`, the server tries providers **sequentially** in this order:

```
Gemini → Groq → OpenRouter → Cloudflare → Cohere → Mistral → OpenCode Zen
```

- **Rate-limit cooldown** — if a provider returns 429, it's put on a 60-second cooldown and the next one is tried immediately. Cooldown state **persists across restarts**.
- **Circuit breaker** — if a provider returns 5+ non-429 errors within 2 minutes (5xx, timeout), it's blocked for 5 minutes, then probed with one test request before being restored.
- **Request queue** — if ALL providers are on cooldown/circuit-open, the request waits up to 30s for the soonest one to recover, then retries automatically instead of immediately failing.
- **Model fallback** — within a single provider, if the default model fails, other chat-capable models are tried before moving to the next provider. Non-chat models (Whisper, prompt-guard) are never tried for chat requests.
- **Response cache** — identical prompts are cached for 5 minutes, skipping all provider calls.
- **Live model sync** — on startup, free models are fetched live from OpenRouter's API (25+ models) and OpenCode Zen's API (5 models). No manual updates needed when they add/remove models.
- **Usage log** — every successful call is logged to `usage-log.jsonl` with token counts.

Each response is prefixed with `[served by: provider/model]` so you always see which backend handled the request.

---

## Providers & Free Tiers

All providers confirmed permanently free — no credit card required, no expiry.

| Provider | Default Model | Free Limit | Notes |
|---|---|---|---|
| [Google Gemini](https://aistudio.google.com/apikey) | gemini-2.5-flash | 1,500 req/day | |
| [Groq](https://console.groq.com/keys) | llama-3.3-70b-versatile | 14,400 req/day | 10 chat models |
| [OpenRouter](https://openrouter.ai/keys) | openrouter/free | Unlimited | 25+ `:free` models, auto-synced |
| [Cloudflare Workers AI](https://dash.cloudflare.com/profile/api-tokens) | llama-3.3-70b-fp8 | 10,000 neurons/day | Hard cap — no charge if exceeded |
| [Cohere](https://dashboard.cohere.com/api-keys) | command-r-plus-08-2024 | 1,000 req/month | Trial key, no CC |
| [Mistral](https://console.mistral.ai/api-keys) | mistral-small-latest | Free mode | No CC required |
| [OpenCode Zen](https://opencode.ai/settings/api-keys) | deepseek-v4-flash-free | Limited time | 5 free models, auto-synced |

> **Removed providers:** SambaNova ($5 credit expires in 3 months → pay-per-use after) and Together AI (free tier removed).

---

## MCP Tools (17)

| Tool | Description |
|---|---|
| `chat_completion` | Send a prompt, get a response from the first available provider |
| `list_providers` | Status, cooldown, circuit breaker, budget, and models for all providers |
| `embed_text` | Generate embedding vectors (Gemini or OpenRouter) |
| `count_tokens` | Estimate token count without making an API call |
| `ping_providers` | Live health-check all providers with latency |
| `get_usage_stats` | Session token/call stats + cache + budget info |
| `set_provider_order` | Change fallback order at runtime without restarting |
| `clear_cache` | Manually flush the in-memory response cache |
| `compare_providers` | Send same prompt to all providers, compare side-by-side |
| `get_benchmarks` | Average/p95 latency and success rate per provider |
| `chat_with_template` | Run a saved prompt template from `./templates/*.md` |
| `summarize_usage_log` | Aggregate `usage-log.jsonl` by day/week/provider |
| `export_usage_report` | Generate Markdown or CSV usage report |
| `translate` | Translate text using a free LLM (no DeepL/Google Translate needed) |
| `summarize` | Summarize text with tuned prompt (bullet/paragraph/tldr) |
| `code_review` | Review code for security/performance/readability |
| `get_reputation` | Provider reputation scores used for auto-reordering |

---

## Two ways to use

### 1. MCP Server (stdio) — for OpenCode, Claude Desktop, etc.

Registered as a tool provider in your MCP client. The AI calls `chat_completion` automatically when it wants free inference.

```bash
npm start
```

### 2. HTTP Proxy (OpenAI-compatible) — for IDEs and CLI tools

Exposes `POST /v1/chat/completions`, `GET /v1/models`, `GET /v1/health` on `localhost:8787`. Point any tool that supports a custom OpenAI base URL at `http://localhost:8787/v1`.

```bash
npm run start:http
```

See [IDE_SETUP.md](IDE_SETUP.md) for per-tool setup (Cursor, Kiro, opencode, Claude Code, etc.).

---

## Installation

### Prerequisites

- **Node.js v18+** — check with `node --version`
- **npm** — comes with Node.js

If you don't have Node.js:
- **Windows / macOS**: Download from https://nodejs.org (LTS version)
- **Linux (Ubuntu/Debian)**: `sudo apt install nodejs npm`
- **Linux (via nvm, recommended)**: https://github.com/nvm-sh/nvm

### Clone & install

```bash
git clone https://github.com/Irsyadmr354/free-ai-router.git
cd free-ai-router
npm install
```

---

## Configure API Keys

Copy the example env file and fill in your keys:

**macOS / Linux:**
```bash
cp .env.example .env
```

**Windows (CMD):**
```cmd
copy .env.example .env
```

**Windows (PowerShell):**
```powershell
Copy-Item .env.example .env
```

Then open `.env` and fill in at least one key:

```env
GEMINI_API_KEY=        # https://aistudio.google.com/apikey
GROQ_API_KEY=          # https://console.groq.com/keys
OPENROUTER_API_KEY=    # https://openrouter.ai/keys
CLOUDFLARE_API_TOKEN=  # https://dash.cloudflare.com/profile/api-tokens
CLOUDFLARE_ACCOUNT_ID= # shown in your Cloudflare dashboard URL
COHERE_API_KEY=        # https://dashboard.cohere.com/api-keys
MISTRAL_API_KEY=       # https://console.mistral.ai/api-keys
OPENCODE_API_KEY=      # https://opencode.ai/settings/api-keys
```

Providers with no key configured are **silently skipped**. You don't need all 7.

---

## Add to OpenCode (MCP config)

Open your OpenCode MCP configuration file and add:

> **Find your config file:**
> - **macOS / Linux**: `~/.config/opencode/config.json`
> - **Windows**: `%APPDATA%\opencode\config.json`
> - Or: Command Palette → "Open MCP Config"

### macOS / Linux

```bash
which node   # e.g. /usr/local/bin/node
pwd          # run inside the free-ai-router folder
```

```json
{
  "mcpServers": {
    "free-ai-router": {
      "command": "/usr/local/bin/node",
      "args": ["/home/YOUR_USERNAME/free-ai-router/index.js"],
      "transport": "stdio"
    }
  }
}
```

### Windows

```json
{
  "mcpServers": {
    "free-ai-router": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\free-ai-router\\index.js"],
      "transport": "stdio"
    }
  }
}
```

> Use double backslashes `\\` in JSON on Windows.

---

## Optional Tuning (`.env`)

```env
# Fallback order (or use set_provider_order tool at runtime)
PROVIDER_ORDER=gemini,groq,openrouter,cloudflare,cohere,mistral,opencode-zen

# Per-provider timeouts in ms (default: 15000)
TIMEOUT_GROQ_MS=10000

# Rate-limit cooldown window (default: 60s)
PROVIDER_COOLDOWN_MS=60000

# Circuit breaker — opens after N failures in WINDOW_MS, recovers after RECOVERY_MS
CIRCUIT_BREAKER_ENABLED=true
CIRCUIT_FAILURE_THRESHOLD=5
CIRCUIT_WINDOW_MS=120000
CIRCUIT_RECOVERY_MS=300000

# Request queue — max wait when all providers unavailable (default: 30s)
REQUEST_QUEUE_ENABLED=true
REQUEST_QUEUE_TIMEOUT_MS=30000

# Response cache TTL (default: 5min)
CACHE_TTL_MS=300000
CACHE_ENABLED=true

# Discord webhook — notified when ALL providers fail simultaneously
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

# HTTP proxy port (default: 8787)
PORT=8787
```

---

## Test manually

```bash
node test-call.js
```

Expected output:
```
[free-ai-router] MCP server v4.0.0 started (stdio transport)
[free-ai-router] OpenRouter: synced 25 free models from live API
[free-ai-router] Running startup health check for: gemini, groq, ...
[free-ai-router] ✅ gemini ready — 432ms
...
=== TOOL RESULT ===
[served by: gemini/gemini-2.5-flash]

Hello!
===================
```

---

## Project Structure

```
free-ai-router/
├── index.js                 # MCP server + 17 tool handlers
├── http-server.js           # OpenAI-compatible HTTP proxy (npm run start:http)
├── providers/
│   ├── gemini.js            # Google Gemini (+ embeddings)
│   ├── groq.js              # Groq (CHAT_MODELS whitelist separates chat from STT/TTS)
│   ├── openrouter.js        # OpenRouter (+ live free model sync + embeddings)
│   ├── cloudflare.js        # Cloudflare Workers AI
│   ├── cohere.js            # Cohere
│   ├── mistral.js           # Mistral AI
│   └── opencode-zen.js      # OpenCode Zen (+ live free model sync)
└── lib/
    ├── router-core.js       # Shared fallback chain (used by both entry points)
    ├── circuit-breaker.js   # CLOSED/OPEN/HALF_OPEN circuit breaker per provider
    ├── request-queue.js     # Queue requests when all providers temporarily unavailable
    ├── cooldown.js          # Rate-limit (429) cooldown tracker — persisted to disk
    ├── cooldown-persist.js  # Cooldown state persistence across restarts
    ├── cache.js             # In-memory response cache
    ├── dedup.js             # Request deduplication for concurrent identical calls
    ├── benchmark.js         # Latency + success rate tracking per provider
    ├── reputation.js        # Dynamic provider reputation scoring
    ├── budget-tracker.js    # Free-tier request budget tracking
    ├── config.js            # All env var configuration
    ├── normalize.js         # Shared response/error shapes
    ├── logger.js            # Stderr-only logger
    ├── notifier.js          # Discord webhook notifications
    ├── sanitize.js          # Input sanitization (null bytes, API key redaction)
    ├── quality-score.js     # Response quality scoring
    ├── lang-detect.js       # Prompt language detection
    ├── chunk.js             # Long-context auto-chunking
    ├── templates.js         # Prompt template loader
    ├── report.js            # Usage report generator
    ├── usage-tracker.js     # Token usage log (usage-log.jsonl)
    ├── tracing.js           # OpenTelemetry-style tracing
    ├── warmup.js            # Background provider warm-up pool
    └── dashboard.js         # Web dashboard (DASHBOARD_ENABLED=true)
```

---

## Troubleshooting

**`Error: Cannot find module`** → Run `npm install` in the project folder.

**Provider shows ❌ at startup** → Check the key in `.env` (no extra spaces or quotes around the value).

**All providers show `no-key`** → Make sure `.env` exists in the project root. Run `cp .env.example .env` and fill it in.

**OpenCode doesn't see the tools** → Verify the `node` and `index.js` paths in your MCP config are absolute and correct for your OS. Restart OpenCode after saving.

**Windows — `node` not found** → Run `where node` in CMD/PowerShell to get the full path.

**macOS/Linux — `node` not found** → Run `which node` to get the full path.

**HTTP proxy not working** → Make sure you ran `npm run start:http` (not `npm start`). Check `http://localhost:8787/v1/health` for diagnostics.

---

## License

MIT — see [LICENSE](LICENSE)
