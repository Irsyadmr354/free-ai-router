# free-ai-router

> A personal AI infrastructure layer — MCP server + OpenAI-compatible HTTP proxy that routes requests across **7 free-tier LLM providers** with intelligent adaptive routing, persistent SQLite storage, circuit breakers, semantic caching, and automated data retention.

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![MCP SDK](https://img.shields.io/badge/@modelcontextprotocol%2Fsdk-1.29.0-blue)](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![Version](https://img.shields.io/badge/version-6.0.0-orange)](CHANGELOG.md)

---

## What it is

free-ai-router is a self-hosted AI router that runs on your laptop and acts as the intelligence layer between your tools and free LLM APIs. Instead of picking one provider and hoping it's available, every request goes through a multi-layer decision engine:

```
Request → Prompt Analysis → MAB Routing → Budget/Anomaly Check
       → Token Saving → Exact Cache → Semantic Cache
       → Provider Fallback Chain (with Circuit Breaker + Queue)
       → Persistent Storage → Response
```

Everything is stored locally in SQLite with automated retention — no data leaves your machine except the actual LLM API calls.

---

## How routing works

### Provider selection (in order of priority)
1. **Exact cache** — identical prompt? Return cached response instantly, no API call
2. **Semantic cache** — similar prompt (≥95% cosine similarity)? Return approximate match
3. **MAB routing** — UCB1 multi-armed bandit algorithm picks the statistically best provider based on reward history, not just latency
4. **Anomaly detection** — provider with 3× latency spike? Deprioritized automatically
5. **Budget awareness** — approaching free tier limit? Move to end of order
6. **Circuit breaker** — 5+ failures in 2 minutes? Block for 5 minutes, probe once to recover
7. **Rate-limit cooldown** — 429 response? 60-second cooldown
8. **Request queue** — all providers unavailable? Wait up to 30s for first recovery, then retry

### Token saving (reduces input token count automatically)
- **Tier 0** (always on): whitespace normalization, JSON/CSS minification
- **Tier 1** (always on): context window trimming, duplicate block deduplication
- **Tier 2** (opt-in): abbreviation dictionary with ROI check
- **Tier 3** (opt-in explicit): LLM-based summarization for very long contexts

---

## Providers & Free Tiers

All confirmed permanently free — no credit card, no expiry.

| Provider | Default Model | Free Limit |
|---|---|---|
| [Google Gemini](https://aistudio.google.com/apikey) | gemini-2.5-flash | 1,500 req/day |
| [Groq](https://console.groq.com/keys) | llama-3.3-70b-versatile | 14,400 req/day |
| [OpenRouter](https://openrouter.ai/keys) | openrouter/free | Unlimited (25+ `:free` models, live-synced) |
| [Cloudflare Workers AI](https://dash.cloudflare.com/profile/api-tokens) | llama-3.3-70b-fp8 | 10,000 neurons/day (hard cap, no charge if exceeded) |
| [Cohere](https://dashboard.cohere.com/api-keys) | command-r-plus-08-2024 | 1,000 req/month |
| [Mistral](https://console.mistral.ai/api-keys) | mistral-small-latest | Free mode (no CC) |
| [OpenCode Zen](https://opencode.ai/settings/api-keys) | deepseek-v4-flash-free | 5 free models (limited time, live-synced) |

---

## MCP Tools (19)

| Tool | Description |
|---|---|
| `chat_completion` | Full provider fallback chain with all intelligence layers |
| `list_providers` | Status, cooldown, circuit breaker, MAB scores, anomaly state |
| `embed_text` | Embedding vectors (Gemini or OpenRouter) |
| `count_tokens` | Estimate tokens without API call |
| `ping_providers` | Live health check with latency |
| `get_usage_stats` | Session token/call stats + cache + budget |
| `set_provider_order` | Change fallback order at runtime |
| `clear_cache` | Flush response cache |
| `compare_providers` | Same prompt → all providers, side-by-side |
| `get_benchmarks` | Latency/success rate per provider |
| `chat_with_template` | Run `./templates/*.md` prompt templates |
| `summarize_usage_log` | Aggregate usage history |
| `export_usage_report` | Markdown or CSV usage report |
| `translate` | Translate text via free LLM |
| `summarize` | Summarize text with tuned prompt |
| `code_review` | Code review with security/performance/readability focus |
| `get_reputation` | Provider reputation scores (0-100) |
| `get_server_health` | Uptime, cache hit rate, circuit states, queue depth |
| `get_token_savings_report` | Aggregated token savings by tier |

---

## Two ways to use

### 1. MCP Server (stdio) — for OpenCode, Claude Desktop, Kiro, etc.

```bash
npm start
```

Add to your MCP config — see [OpenCode setup](#add-to-opencode-mcp-config) below.

### 2. HTTP Proxy (OpenAI-compatible) — for IDEs and CLI tools

```bash
npm run start:http
# → http://localhost:8787/v1
```

Point any tool with an "OpenAI base URL" setting at `http://localhost:8787/v1`. See [IDE_SETUP.md](IDE_SETUP.md) for Cursor, Kiro, opencode, Claude Code.

---

## Storage

All state is persisted to SQLite in `./data/`:

```
data/
├── router.db          ← operational state: cooldowns, reputation, MAB scores,
│                         circuit breakers, benchmark samples, response cache,
│                         usage log, semantic cache embeddings
├── conversations.db   ← conversation history with tiered retention
└── archive/           ← auto-generated monthly archives (JSONL)
```

**Storage footprint:** ~18MB after 1 year of typical personal use. The retention system automatically:
- Keeps full conversation text for 30 days
- Archives to `data/archive/` after 30 days, deletes from DB after 90 days
- Prunes benchmark samples older than 7 days
- Archives usage log entries older than 90 days

---

## Installation

### Prerequisites
- **Node.js v22+** (uses built-in `node:sqlite`)
- **npm**

```bash
git clone https://github.com/Irsyadmr354/free-ai-router.git
cd free-ai-router
npm install
```

### Configure API Keys

```bash
# macOS/Linux
cp .env.example .env

# Windows
copy .env.example .env
```

Fill in at least one key:

```env
GEMINI_API_KEY=        # https://aistudio.google.com/apikey
GROQ_API_KEY=          # https://console.groq.com/keys
OPENROUTER_API_KEY=    # https://openrouter.ai/keys
CLOUDFLARE_API_TOKEN=  # https://dash.cloudflare.com/profile/api-tokens
CLOUDFLARE_ACCOUNT_ID= # from your Cloudflare dashboard URL
COHERE_API_KEY=        # https://dashboard.cohere.com/api-keys
MISTRAL_API_KEY=       # https://console.mistral.ai/api-keys
OPENCODE_API_KEY=      # https://opencode.ai/settings/api-keys
```

---

## Add to OpenCode (MCP config)

**macOS / Linux:**
```bash
which node   # e.g. /usr/local/bin/node
pwd          # run inside free-ai-router folder
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

**Windows:**
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

---

## Key Configuration

```env
# Routing intelligence
MAB_ROUTING_ENABLED=true           # UCB1 multi-armed bandit (default: true)
PROMPT_ANALYSIS_ROUTING=true       # Prompt complexity → provider affinity (default: false)
ANOMALY_DETECTION_ENABLED=true     # Auto-deprioritize latency spikes (default: true)
ANOMALY_SPIKE_THRESHOLD=3.0        # Latency spike = 3x baseline (default: 3.0)

# Semantic cache
SEMANTIC_CACHE_ENABLED=true        # Cosine similarity cache (default: false, needs Gemini key)
SEMANTIC_CACHE_THRESHOLD=0.95      # Similarity threshold (default: 0.95)

# Conversation storage
CONVERSATION_STORAGE_ENABLED=true  # Persist conversation history (default: true)

# Data retention
RETENTION_HOT_DAYS=7               # Full text retention (default: 7)
RETENTION_WARM_DAYS=30             # Archive after (default: 30)
RETENTION_COLD_DAYS=90             # Delete from DB after (default: 90)
MAX_ROUTER_DB_MB=100               # Hard size cap for router.db (default: 100MB)

# Token saving
TOKEN_SAVING_ENABLED=true          # Tier 0+1 always on (default: true)
CONTEXT_TRIM_THRESHOLD_TOKENS=8000 # Trigger context trimming above (default: 8000)
```

See `.env.example` for the full list.

---

## Test

```bash
node test-call.js
```

```bash
npm run check   # syntax check all 48 files
```

---

## Project Structure

```
free-ai-router/
├── index.js                    MCP server + 19 tool handlers
├── http-server.js              OpenAI-compatible HTTP proxy
├── data/                       SQLite databases (auto-created)
├── providers/                  7 provider modules
└── lib/
    ├── router-core.js          Shared fallback chain
    ├── db.js                   SQLite unified state store
    ├── middleware.js            Composable request pipeline
    ├── mab-routing.js          UCB1 multi-armed bandit routing
    ├── anomaly-detector.js     Proactive latency spike detection
    ├── prompt-analyzer.js      Prompt complexity + provider affinity
    ├── semantic-cache.js       Cosine similarity response cache
    ├── conversations.js        Persistent conversation storage
    ├── data-retention.js       Automated tiered retention scheduler
    ├── circuit-breaker.js      CLOSED/OPEN/HALF_OPEN per provider
    ├── request-queue.js        Queue when all providers unavailable
    ├── token-saver.js          4-tier token saving pipeline
    ├── benchmark.js            Latency tracking (SQLite-backed)
    ├── reputation.js           0-100 scores (SQLite-backed)
    ├── cooldown.js             429 cooldown (SQLite-backed)
    ├── cache.js                Exact-match response cache
    ├── budget-tracker.js       Free-tier budget tracking
    └── ...                     12 more utility modules
```

---

## License

MIT — see [LICENSE](LICENSE)
