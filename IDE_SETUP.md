# IDE / CLI Setup — free-ai-router as your main model

`http-server.js` exposes an OpenAI-compatible HTTP endpoint
(`POST /v1/chat/completions`, `GET /v1/models`) that any tool supporting a
custom "OpenAI API base URL" can point at — replacing the tool's default
paid model with the free-tier router, instead of only being usable as an
optional MCP tool.

## Start the server

```bash
npm run start:http
```

By default it listens on `http://localhost:8787`. Change the port with the
`PORT` env var in `.env` if 8787 is taken.

- **Base URL to use in every tool below:** `http://localhost:8787/v1`
- **API key field:** any non-empty string works, e.g. `free-ai-router`. Real
  provider authentication happens server-side via your `.env` — the client
  never needs a real key.
- **Streaming:** real per-chunk SSE forwarding is implemented, so streaming
  responses show up incrementally in-editor, not all at once at the end.

Since all tools below hit the same HTTP process, cooldown/reputation/budget
tracking (batch-tracker, cooldown.js, reputation.js) is now **shared across
every tool automatically** — a rate-limit hit in Cursor will make opencode
skip that provider too, for example. That's an improvement over the old
MCP setup, where each tool ran its own separate stdio process with
independent state.

---

## BAGIAN A — GUI IDE

### Cursor
Settings → Models → **OpenAI API Base URL** (or "Override OpenAI Base URL")
→ set to `http://localhost:8787/v1`. Set the API key field to any non-empty
string. Cursor should auto-detect the model list via `GET /v1/models`; if
not, pick "custom model" and type any model id from that list (or just
`free-ai-router` — the router ignores the `model` field's exact provider
prefix and applies its normal fallback chain unless you target one
specifically).

### Antigravity IDE
Look for Settings → Models (or "AI Provider") → a field for a custom
OpenAI-compatible endpoint. Set the base URL to
`http://localhost:8787/v1` and the API key to any non-empty string.

### Kiro IDE
Look for Settings → Models / Providers → custom OpenAI-compatible provider
option. Same base URL and dummy API key as above.

> **Note on GUI settings paths:** exact menu wording changes between
> releases of these IDEs. If you can't find the setting, search their
> settings UI for "OpenAI", "base URL", or "custom provider" — the
> underlying mechanism (an OpenAI-compatible base URL override) is standard
> across all three.

---

## BAGIAN B — CLI / terminal-based tools

**⚠️ Important: the env var names and config file paths below are educated
guesses based on common patterns used by similar CLI tools, NOT confirmed
against each tool's current official documentation.** These tools are
actively evolving and their configuration surface can change between
releases. Before relying on any of these, verify with:

```bash
<tool> --help
```

or the tool's official docs, and paste the output back if you want the
exact instructions confirmed/corrected.

### opencode CLI
Likely pattern: environment variable such as `OPENAI_API_BASE` or
`OPENAI_BASE_URL`, or a project-level config file such as `.opencode.json`
in your project root. **Verify with `opencode --help` or the opencode docs**
before trusting an exact key name.

Educated-guess env var approach:
```bash
export OPENAI_BASE_URL=http://localhost:8787/v1
export OPENAI_API_KEY=free-ai-router
```

### Claude Code
Claude Code natively expects Anthropic's API shape, not OpenAI's — so
pointing it at this OpenAI-compatible endpoint may need a translation layer
rather than direct base-URL override, or may not be supported at all
depending on the version you have installed. Check `claude --help` and
Anthropic's own docs for whatever custom-endpoint mechanism (if any) your
installed version supports before assuming `ANTHROPIC_BASE_URL` works
out of the box with an OpenAI-shaped server like this one.

### Kiro CLI
Likely pattern: similar to Kiro IDE's config, possibly a config file under
`~/.config/kiro/` or an env var like `KIRO_API_BASE_URL`. **Verify with
`kiro --help`** — naming here is a guess.

### Antigravity CLI
Likely pattern: env var such as `ANTIGRAVITY_BASE_URL` or a config file
under `~/.config/antigravity/`. **Verify with `antigravity --help`** —
naming here is a guess.

---

## If a tool has no "custom base URL" option at all

Some tools hardcode their model provider with no override mechanism. If
that's the case for one of the tools above, that's a limitation of that
specific tool, not of `http-server.js` — the router's endpoint is a
standard OpenAI-compatible HTTP API and will work with anything that
supports pointing at one.

---

## Testing it yourself

Non-streaming:
```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hi in one sentence."}],"stream":false}'
```

Streaming (note `-N` to disable curl's output buffering so you see chunks
arrive incrementally):
```bash
curl -N -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Count from 1 to 10 slowly."}],"stream":true}'
```

Model list:
```bash
curl http://localhost:8787/v1/models
```

Health/config check:
```bash
curl http://localhost:8787/v1/health
```
