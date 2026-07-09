/**
 * lib/sse-forward.js
 * Writes OpenAI-compatible SSE chat.completion.chunk events to an HTTP
 * response object (Node http `res` / Express `res` — same API surface).
 *
 * This is the client-facing counterpart to lib/sse.js (which *consumes* SSE
 * from upstream providers). This module *produces* SSE toward whatever
 * called http-server.js (Cursor, opencode, Claude Code, etc).
 */

/**
 * Write proper SSE headers and flush them immediately so Node doesn't
 * buffer the first chunk. Must be called once, before any writeChunk() call.
 * @param {import('http').ServerResponse} res
 */
export function startSse(res, { vercelAiDataStream = false } = {}) {
  const headers = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no", // disable proxy buffering (nginx etc.) if ever put behind one
  };
  // Vercel AI SDK (useChat/useCompletion) looks for this response header to
  // recognize a data-stream-compatible endpoint. The chunk payloads we send
  // are already OpenAI-compatible SSE, which the AI SDK's OpenAI-compatible
  // provider understands directly — this header just lets clients that
  // sniff for it (rather than being told the provider explicitly) detect
  // this endpoint as stream-capable.
  if (vercelAiDataStream) {
    headers["x-vercel-ai-data-stream"] = "v1";
  }
  res.writeHead(200, headers);
  if (typeof res.flushHeaders === "function") res.flushHeaders();
}

/**
 * Write one OpenAI-style chat.completion.chunk SSE event.
 * @param {import('http').ServerResponse} res
 * @param {object} p
 * @param {string} p.id
 * @param {string} p.model
 * @param {string} p.deltaText - the incremental content delta
 * @param {Array} [p.toolCalls] - tool_calls to include in delta (OpenAI format: [{id, type, function}])
 * @param {string|null} [p.finishReason] - null while streaming, "stop"/"length"/etc on the final chunk
 * @param {number} [p.created] - unix seconds, defaults to now
 */
export function writeChunk(res, { id, model, deltaText, toolCalls, finishReason = null, created }) {
  const delta = {};
  if (finishReason === null) {
    if (toolCalls?.length) {
      delta.tool_calls = toolCalls.map((tc, i) => ({
        index: i,
        id: tc.id,
        type: tc.type,
        function: tc.function,
      }));
    } else {
      delta.content = deltaText ?? "";
    }
  }
  const payload = {
    id,
    object: "chat.completion.chunk",
    created: created ?? Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Write the terminating [DONE] event and end the response.
 * @param {import('http').ServerResponse} res
 */
export function endSse(res) {
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * High-level helper: drive a full streamed chat completion to the client.
 *
 * @param {import('http').ServerResponse} res - the HTTP response to write SSE to
 * @param {import('http').IncomingMessage} req - the HTTP request, used to detect client disconnect
 * @param {object} p
 * @param {string} p.id - completion id to use in every chunk
 * @param {string} p.model - model name to report in chunks (may be updated once the real model is known)
 * @param {(ctx: { onDelta: (text: string) => void, abortSignal: AbortSignal }) => Promise<{ model?: string }>} p.source
 *   A function that performs the actual upstream call. It receives an
 *   onDelta callback to invoke per chunk, and an abortSignal it should pass
 *   to its upstream fetch() so a client disconnect cancels the upstream
 *   request too. It may resolve with an object containing the final model
 *   name (e.g. if a fallback model was used) to correct the reported model.
 * @returns {Promise<void>}
 */
export async function forwardStream(res, req, { id, model, source, vercelAiDataStream = false }) {
  const controller = new AbortController();
  let clientClosed = false;

  const onClose = () => {
    clientClosed = true;
    controller.abort();
  };
  req.on("close", onClose);

  startSse(res, { vercelAiDataStream });

  let reportedModel = model;
  let wroteAnyChunk = false;

  try {
    const onDelta = (text) => {
      if (clientClosed || !text) return;
      wroteAnyChunk = true;
      writeChunk(res, { id, model: reportedModel, deltaText: text });
    };

    const result = await source({ onDelta, abortSignal: controller.signal });
    if (result?.model) reportedModel = result.model;

    if (!clientClosed) {
      if (result?.toolCalls?.length) {
        // Chunk with tool_calls delta (finish_reason: null)
        writeChunk(res, { id, model: reportedModel, toolCalls: result.toolCalls });
        // Final chunk with finish_reason: "tool_calls" and empty delta
        writeChunk(res, { id, model: reportedModel, deltaText: "", finishReason: "tool_calls" });
      } else {
        // Final chunk carries finish_reason: "stop" and no content, per OpenAI spec.
        writeChunk(res, { id, model: reportedModel, deltaText: "", finishReason: "stop" });
      }
      endSse(res);
    }
  } catch (err) {
    if (!clientClosed) {
      // Best-effort: if we already streamed content, we can't cleanly turn
      // this into a JSON error response (headers are already sent as SSE),
      // so surface the error as a final SSE chunk instead of a raw HTTP error.
      if (wroteAnyChunk) {
        writeChunk(res, {
          id,
          model: reportedModel,
          deltaText: `\n\n[error: ${err?.message ?? err}]`,
          finishReason: "stop",
        });
        endSse(res);
      } else {
        // Nothing streamed yet — safe to end with an SSE error event, since
        // headers went out at startSse() but no chunk data has been sent.
        res.write(`data: ${JSON.stringify({ error: { message: String(err?.message ?? err) } })}\n\n`);
        endSse(res);
      }
    }
  } finally {
    req.off("close", onClose);
  }
}
