// biome-ignore-all lint/style/useNamingConvention: OpenTelemetry names its JSON fields this way.
// A very small tracing library. It does what an OpenTelemetry SDK does for this course:
// it makes spans, links each child to its parent, carries baggage down, and sends the spans
// to a trace store in the OpenTelemetry (OTLP) JSON format. You do not need to change it.
type Value = string | number;

export type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startNanos: bigint;
  endNanos?: bigint;
  attributes: Record<string, Value>;
  // Values that travel to every child span, such as the importer this work is for.
  baggage: Record<string, Value>;
};

const finishedSpans: Span[] = [];

function randomHex(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return Buffer.from(bytes).toString("hex");
}

const nowInNanos = () => BigInt(Date.now()) * 1_000_000n;

// Start a span. With a parent, the span joins the parent's trace and gets its baggage.
// Without a parent, the span starts a new trace of its own.
export function startSpan(
  name: string,
  parent?: Span,
  attributes: Record<string, Value> = {},
): Span {
  return {
    traceId: parent?.traceId ?? randomHex(16),
    spanId: randomHex(8),
    parentSpanId: parent?.spanId,
    name,
    startNanos: nowInNanos(),
    attributes: { ...attributes },
    baggage: { ...(parent?.baggage ?? {}) },
  };
}

export function endSpan(span: Span): void {
  span.endNanos = nowInNanos();
  finishedSpans.push(span);
}

function otlpValue(value: Value) {
  if (typeof value === "number") return { intValue: String(value) };
  return { stringValue: value };
}

// Baggage is written onto every span, so each span can be found by importer, team or run.
function otlpSpan(span: Span) {
  const allAttributes = { ...span.baggage, ...span.attributes };
  const attributes = Object.entries(allAttributes).map(([key, value]) => ({
    key,
    value: otlpValue(value),
  }));
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId ?? "",
    name: span.name,
    startTimeUnixNano: String(span.startNanos),
    endTimeUnixNano: String(span.endNanos ?? span.startNanos),
    attributes,
  };
}

// Send every finished span to the trace store named by OTEL_EXPORTER_OTLP_ENDPOINT.
export async function flush(serviceName: string): Promise<void> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || finishedSpans.length === 0) return;
  const resource = { attributes: [{ key: "service.name", value: otlpValue(serviceName) }] };
  const scopeSpans = [{ scope: { name: "harbourgate" }, spans: finishedSpans.map(otlpSpan) }];
  const body = JSON.stringify({ resourceSpans: [{ resource, scopeSpans }] });
  const headers = { "content-type": "application/json" };
  await fetch(`${endpoint}/v1/traces`, { method: "POST", headers, body });
  finishedSpans.length = 0;
}
