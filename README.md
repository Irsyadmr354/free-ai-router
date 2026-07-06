# free-ai-router

> A stdio MCP server that routes `chat_completion` requests across **7 free-tier LLM providers** with automatic fallback, cooldown tracking, response caching, and usage logging — so you never hit a hard stop when one provider's free quota runs out.

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![MCP SDK](https://img.shields.io/badge/@modelcontextprotocol%2Fsdk-1.29.0-blue)](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![CI](https://github.com/Irsyadmr354/free-ai-router/actions/workflows/ci.yml/badge.svg)](https://github.com/Irsyadmr354/free-ai-router/actions/workflows/ci.yml)

---

## How it works

When you call `chat_completion`, the server tries providers **sequentially** in this order:

```
Gemini → Groq → OpenRouter → Cloudflare → SambaNova → Cohere → Mistral
```

- If a provider returns **429 (rate-limited)**, it is put on a **60-second cooldown** and the next provider is tried immediately — no wasted quota. Cooldown state **persists across restarts**.
- If a provider fails for any other reason (5xx, timeout, bad key), it falls through to the next one.
- **Identical prompts are cached for 5 minutes** — repeated calls skip all provider calls entirely.
- Every successful call is **logged to `usage-log.jsonl`** with token counts.
- The fallback order is **fully configurable** via `PROVIDER_ORDER` in `.env` or the `set_provider_order` tool at runtime.
- On startup, the server **automatically pings all configured providers** and logs which ones are ready.

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
| [Cohere](https://dashboard.cohere.com/api-keys) | command-r-plus-08-2024 | 1,000 req/month |
| [Mistral](https://console.mistral.ai/api-keys) | mistral-small-latest | Free tier |

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
| `set_provider_order` | Change fallback order at runtime without restarting |

---

## Installation

### Prerequisites

- **Node.js v18+** — check with `node --version`
- **npm** — comes with Node.js
- **Git**

If you don't have Node.js:
- **Windows / macOS**: Download from https://nodejs.org (LTS version)
- **Linux (Ubuntu/Debian)**: `sudo apt install nodejs npm`
- **Linux (via nvm, recommended)**: https://github.com/nvm-sh/nvm

---

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

Then open `.env` and fill in at least one key to get started:

```env
# Required — get at least one of these
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

Providers with no key configured are **silently skipped**. You don't need all 7.

---

## Add to OpenCode (MCP config)

Open your OpenCode MCP configuration file and add the entry below.

> **Find your config file:**
> - **macOS**: `~/.config/opencode/config.json`
> - **Linux**: `~/.config/opencode/config.json`
> - **Windows**: `%APPDATA%\opencode\config.json`
>
> Or use the Command Palette: `Ctrl+Shift+P` → "Open MCP Config"

### macOS

First, find your paths:
```bash
which node          # e.g. /usr/local/bin/node  or  /opt/homebrew/bin/node
pwd                 # run this inside the free-ai-router folder
```

Then add to your config:
```json
{
  "mcpServers": {
    "free-ai-router": {
      "command": "/usr/local/bin/node",
      "args": ["/Users/YOUR_USERNAME/free-ai-router/index.js"],
      "transport": "stdio"
    }
  }
}
```

> Replace `/usr/local/bin/node` with your actual `which node` output, and the path with your actual clone location.

### Linux

```bash
which node          # e.g. /usr/bin/node  or  /home/user/.nvm/versions/node/v20.0.0/bin/node
pwd                 # run this inside the free-ai-router folder
```

```json
{
  "mcpServers": {
    "free-ai-router": {
      "command": "/usr/bin/node",
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

> **Tip:** On Windows, always use double backslashes `\\` in JSON strings.

After saving, restart OpenCode (or reload MCP servers) — the tools will appear automatically.

---

## Test manually (without OpenCode)

Run the included test script to verify everything works end-to-end:

```bash
node test-call.js
```

You will see:
- Provider startup health check results on **stderr**
- The full MCP JSON exchange on **stdout**
- The final tool result with `[served by: provider/model]` prefix

Expected output:
```
[free-ai-router] MCP server v3.0.0 started (stdio transport)
[free-ai-router] Running startup health check for: gemini, groq, ...
[free-ai-router] ✅ gemini ready — 432ms
...
=== TOOL RESULT ===
[served by: gemini/gemini-2.5-flash]

Hello!
===================
```

---

## Optional Tuning (via `.env`)

```env
# Change fallback order (or use the set_provider_order tool at runtime)
PROVIDER_ORDER=groq,gemini,openrouter,cloudflare,sambanova,cohere,mistral

# Per-provider request timeouts in ms (default: 15000)
TIMEOUT_GROQ_MS=10000
TIMEOUT_GEMINI_MS=20000

# Rate-limit cooldown window in ms (default: 60000 = 60s)
PROVIDER_COOLDOWN_MS=60000

# Response cache TTL in ms (default: 300000 = 5min). Set CACHE_ENABLED=false to disable.
CACHE_TTL_MS=300000
CACHE_ENABLED=true

# Usage log file path (default: ./usage-log.jsonl)
USAGE_LOG_PATH=./usage-log.jsonl
USAGE_TRACKING=true

# Discord webhook — notified when ALL providers fail simultaneously
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

---

## Project Structure

```
free-ai-router/
├── index.js                 # MCP server + all 7 tool handlers
├── providers/
│   ├── gemini.js            # Google Gemini (+ embeddings)
│   ├── groq.js              # Groq
│   ├── openrouter.js        # OpenRouter (+ embeddings)
│   ├── cloudflare.js        # Cloudflare Workers AI
│   ├── sambanova.js         # SambaNova Cloud
│   ├── cohere.js            # Cohere
│   └── mistral.js           # Mistral AI
└── lib/
    ├── normalize.js         # Shared response/error shapes
    ├── logger.js            # Stderr-only logger
    ├── cooldown.js          # Rate-limit cooldown tracker (in-memory)
    ├── cooldown-persist.js  # Persists cooldown state across restarts
    ├── cache.js             # In-memory response cache
    ├── config.js            # Provider order + timeout config
    ├── usage-tracker.js     # Token usage log
    └── notifier.js          # Discord webhook notifications
```

---

## Troubleshooting

**`Error: Cannot find module`**
→ Run `npm install` in the project folder.

**Provider shows ❌ at startup but I have a key**
→ Check that the key is correctly set in `.env` (no extra spaces, no quotes around the value).

**All providers show `no-key`**
→ Make sure `.env` exists and is in the project root. Run `cp .env.example .env` and fill it in.

**OpenCode doesn't see the tools**
→ Verify the `node` path and `index.js` path in your MCP config are absolute and correct for your OS. Restart OpenCode after saving.

**Windows: `node` not found**
→ Run `where node` in CMD/PowerShell to get the full path, then use that in your MCP config.

**macOS/Linux: `node` not found**
→ Run `which node` to get the full path.

---

## License

MIT — see [LICENSE](LICENSE)
