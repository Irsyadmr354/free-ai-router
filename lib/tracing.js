/**
 * lib/tracing.js
 * Minimal OpenTelemetry-style tracing without the full OTel SDK dependency
 * (keeps the package free of a heavy dependency tree). Emits spans in a
 * standard-shaped JSON — {traceId, spanId, name, startTime, endTime,
 * durationMs, attributes} — either to stderr (console exporter) or POSTed
 * to an OTLP/Jaeger HTTP collector if OTEL_EXPORTER_URL is set.
 *
 * Enable via TRACING_ENABLED=true.
 */

import { randomUUID } from "crypto";
import { logError } from "./logger.js";

export function isTracingEnabled() {
  return process.env.TRACING_ENABLED === "true";
}

function exporterUrl() {
  return process.env.OTEL_EXPORTER_URL || null;
}

/**
 * Start a span. Call .end(attributes) when the operation completes.
 * @param {string} name
 * @param {Record<string, any>} [attributes]
 */
export function startSpan(name, attributes = {}) {
  const traceId = randomUUID();
  const spanId = randomUUID().slice(0, 16);
  const startTime = Date.now();

  return {
    end(extraAttributes = {}) {
      if (!isTracingEnabled()) return;
      const endTime = Date.now();
      const span = {
        traceId,
        spanId,
        name,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        durationMs: endTime - startTime,
        attributes: { ...attributes, ...extraAttributes },
      };
      emit(span);
    },
  };
}

function emit(span) {
  const url = exporterUrl();
  if (!url) {
    // Console exporter — stderr only, keeps stdout clean for MCP protocol.
    console.error(`[trace] ${JSON.stringify(span)}`);
    return;
  }

  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(span),
    signal: AbortSignal.timeout(3000),
  }).catch((err) => {
    logError(`Trace export to ${url} failed: ${err.message}`);
  });
}
