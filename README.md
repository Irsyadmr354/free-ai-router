# free-ai-router

> A stdio MCP server that routes `chat_completion` requests across **7 free-tier LLM providers** with automatic fallback, cooldown tracking, response caching, and usage logging — so you never hit a hard stop when one provider's free quota runs out.

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![MCP SDK](https://img.shields.io/badge/@modelcontextprotocol%2Fsdk-1.29.0-blue)](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

---

## How it works

When you call `chat_completion`, the server tries providers **sequentially** in this order:

```
Gemini → Groq → OpenRouter → Cloudflare → SambaNova → Cohere → Mistral
```

- If a provider returns **429 (rate-limited)**, it's put on a **60-second cooldown** and the next provider is tried immediately — no wasted quota.
- If a provider fails for any other reason (5xx, timeout, bad key), it also falls through to the next one.
- **Identical prompts are cached for 5 minutes** — repeated calls skip all providers entirely.
- Every successful call is **logged to `usage-log.jsonl`** with token counts.
- The fallback order is **fully configurable** via `PROVIDER_ORDER` in `.env`.

Each response is prefixed with `[served by: provider/model]` so you always see which backend handled the request.

---

## Providers & Free Tiers

| Provider | Default Model | Free Limit |
|---|---|---|
| [Google Gemini](https://aistudio.google.com/apikey) | gemini-2.5-flash | 1,500 req/day |
| [Groq](https://console.groq.com/keys) | llama-3.3-70b-versatile | 14,400 req/day |
| [OpenRouter](https://openrouter.ai/keys) | openrouter/auto | Unlimited (`:free` models) |
| [Cloudflare Workers AI](https://dash.cloudflare.com/profile/api-tokens) | llama-3.3-70b-fp8 | 10,000 neurons/day |
| [SambaNova](https://cloud.sambanova.ai/apis) | Meta-Llama-3.3-70B-Instruct | 48,000 req/day |
| [Cohere](https://dashboard.cohere.com/api-keys) | command-r | 1,000 req/month |
| [Mistral](https://console.mistral.ai/api-keys) | mistral-small-latest | Free tier (verify phone) |

---

## MCP Tools

| Tool | Description |
|---|---|
| `chat_completion` | Send a prompt, get a response from the first available provider |
| `list_providers` | See status, cooldown, and models for all providers |
| `embed_text` | Generate embedding vectors (Gemini or OpenRouter) |
| `count_tokens` | Estimate token count without making an API call |
| `ping_providers` | Live health-check all providers with latency |
| `get_usage_stats` | Session token/call stats + cache info |

---

## Install

```bash
git clone https://github.com/Irsyadmr354/free-ai-router.git
cd free-ai-router
npm install
```

---

## Configure API Keys

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

```env
# Required — get at least one of these to start
GEMINI_API_KEY=        # https://aistudio.google.com/apikey
GROQ_API_KEY=          # https://console.groq.com/keys
OPENROUTER_API_KEY=    # https://openrouter.ai/keys

# Optional extras
CLOUDFLARE_API_TOKEN=  # https://dash.cloudflare.com/profile/api-tokens
CLOUDFLARE_ACCOUNT_ID= # shown in your Cloudflare dashboard URL
SAMBANOVA_API_KEY=     # https://cloud.sambanova.ai/apis
COHERE_API_KEY=        # https://dashboard.cohere.com/api-keys
MISTRAL_API_KEY=       # https://console.mistral.ai/api-keys
```

Providers with no key configured are **silently skipped** — you don't need all 7.

---

## Add to OpenCode (MCP config)

Open your OpenCode MCP configuration file and add:

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

Restart OpenCode — the tools will appear automatically.

---

## Optional Tuning (via `.env`)

```env
# Change fallback order
PROVIDER_ORDER=groq,gemini,openrouter,cloudflare,sambanova,cohere,mistral

# Per-provider timeouts (ms)
TIMEOUT_GROQ_MS=10000
TIMEOUT_GEMINI_MS=15000

# Rate-limit cooldown window (default: 60s)
PROVIDER_COOLDOWN_MS=60000

# Response cache TTL (default: 5min). Set to false to disable.
CACHE_TTL_MS=300000
CACHE_ENABLED=true

# Usage log
USAGE_LOG_PATH=./usage-log.jsonl
USAGE_TRACKING=true
```

---

## Test Manually

```bash
node test-call.js
```

You'll see provider logs on stderr and the full MCP response on stdout.

---

## Project Structure

```
free-ai-router/
├── index.js              # MCP server + all tool handlers
├── providers/
│   ├── gemini.js         # Google Gemini (+ embeddings)
│   ├── groq.js           # Groq
│   ├── openrouter.js     # OpenRouter (+ embeddings)
│   ├── cloudflare.js     # Cloudflare Workers AI
│   ├── sambanova.js      # SambaNova Cloud
│   ├── cohere.js         # Cohere
│   └── mistral.js        # Mistral AI
└── lib/
    ├── normalize.js      # Shared response/error shapes
    ├── logger.js         # Stderr-only logger
    ├── cooldown.js       # Rate-limit cooldown tracker
    ├── cache.js          # In-memory response cache
    ├── config.js         # Provider order + timeout config
    └── usage-tracker.js  # Token usage log
```

---

## License

MIT
