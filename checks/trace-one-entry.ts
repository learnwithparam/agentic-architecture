// biome-ignore-all lint/style/useNamingConvention: settings like RUN_ID are in capitals.
// One entry, one trace. The check runs your Classification entry on HG-1049 against the finished
// gateway and tool gateway, receives your spans in a small trace store (OpenTelemetry JSON),
// and compares them with what the gateways recorded. It never reads a model's reply.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startPlatform } from "../reference/platform";
import type { Rule } from "../scripts/verify";
import type { World } from "../world/services";
import { keyOf } from "./lib/gateway";
import { platformToml } from "./lib/learner";
import { once } from "./lib/session";
import { allRows, firstRow, freshWorld, ROOT } from "./lib/world";

const SHIPMENT = "HG-1049";
const IMPORTER = "fjordline";
const RUN_ID = "trace-drill-HG-1049";
const RUN_TIMEOUT_MS = 8000;
export const TRACE_FILE = join(ROOT, "world", "state", "last-trace.json");

export type ReceivedSpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  attributes: Record<string, string>;
};

type OtlpAttribute = { key: string; value: { stringValue?: string; intValue?: string } };
type OtlpSpan = Omit<ReceivedSpan, "attributes"> & { attributes?: OtlpAttribute[] };
type OtlpBody = { resourceSpans?: { scopeSpans?: { spans?: OtlpSpan[] }[] }[] };

function flatten(span: OtlpSpan): ReceivedSpan {
  const attributes: Record<string, string> = {};
  for (const attribute of span.attributes ?? []) {
    attributes[attribute.key] = String(attribute.value.stringValue ?? attribute.value.intValue);
  }
  return { ...span, parentSpanId: span.parentSpanId ?? "", attributes };
}

// A trace store that keeps every span sent to POST /v1/traces, like a collector would.
export function startTraceStore() {
  const spans: ReceivedSpan[] = [];
  const receive = async (request: Request): Promise<Response> => {
    const body: OtlpBody = await request.json().catch(() => ({}));
    for (const resource of body.resourceSpans ?? []) {
      for (const scope of resource.scopeSpans ?? [])
        spans.push(...(scope.spans ?? []).map(flatten));
    }
    return Response.json({});
  };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: receive });
  return { url: `http://127.0.0.1:${server.port}`, spans, stop: () => server.stop(true) };
}

async function runEntry(folder: string, settings: Record<string, string>): Promise<number | null> {
  const command = platformToml(folder).entry?.run;
  if (!command) return null;
  const entry = Bun.spawn(["sh", "-c", `exec ${command}`], {
    cwd: folder,
    env: { ...process.env, ...settings },
    stdout: "ignore",
    stderr: "ignore",
  });
  const timer = setTimeout(() => entry.kill(9), RUN_TIMEOUT_MS);
  const exitCode = await entry.exited;
  clearTimeout(timer);
  return exitCode;
}

type Recorded = { tokensIn: number; tokensOut: number; modelCalls: number; toolCalls: number };

function whatTheGatewaysRecorded(world: World): Recorded {
  const spend = firstRow<{ tokensIn: number; tokensOut: number; calls: number }>(
    world,
    "SELECT COALESCE(SUM(tokens_in),0) AS tokensIn, COALESCE(SUM(tokens_out),0) AS tokensOut, " +
      "COUNT(*) AS calls FROM spend_log WHERE run_id = ? AND status = 'ok'",
    RUN_ID,
  );
  const toolCalls = allRows(
    world,
    "SELECT id FROM spans WHERE kind = 'tool' AND run_id = ?",
    RUN_ID,
  );
  return {
    tokensIn: spend.tokensIn,
    tokensOut: spend.tokensOut,
    modelCalls: spend.calls,
    toolCalls: toolCalls.length,
  };
}

// Text a span must never hold: invoice documents, team keys and agent tokens.
function sensitiveText(world: World): string[] {
  const documents = allRows<{ body: string }>(
    world,
    "SELECT body FROM documents WHERE shipment = ?",
    SHIPMENT,
  );
  const openings = documents.map((document) => document.body.slice(0, 24));
  return [...openings, keyOf("classification"), "hgk_", "eyJ"];
}

type Outcome = {
  error?: string;
  exitCode: number | null;
  spans: ReceivedSpan[];
  recorded: Recorded;
  sensitive: string[];
};

async function scenario(folder: string): Promise<Outcome> {
  const world = await freshWorld();
  const store = startTraceStore();
  const stateFolder = join(ROOT, "world", "state", "trace-drill");
  mkdirSync(stateFolder, { recursive: true });
  const platform = await startPlatform(world, join(stateFolder, "platform.db"));
  try {
    const settings = {
      ...world.env,
      ...platform.env,
      AGENT: "classification-agent",
      TEAM_KEY: keyOf("classification"),
      IMPORTER,
      SHIPMENT,
      RUN_ID,
      OTEL_EXPORTER_OTLP_ENDPOINT: store.url,
    };
    const exitCode = await runEntry(folder, settings);
    await Bun.sleep(100);
    writeFileSync(TRACE_FILE, JSON.stringify(store.spans, null, 2));
    const recorded = whatTheGatewaysRecorded(world);
    return { exitCode, spans: store.spans, recorded, sensitive: sensitiveText(world) };
  } finally {
    await platform.stop();
    store.stop();
    world.stop();
  }
}

function run(folder: string): Promise<Outcome> {
  return once("trace-one-entry", folder, scenario);
}

const operation = (span: ReceivedSpan) => span.attributes["gen_ai.operation.name"];
const modelSpans = (spans: ReceivedSpan[]) => spans.filter((span) => operation(span) === "chat");
const toolSpans = (spans: ReceivedSpan[]) =>
  spans.filter((span) => operation(span) === "execute_tool");

function isOneTrace(spans: ReceivedSpan[]): boolean {
  if (spans.length < 2) return false;
  const traceIds = new Set(spans.map((span) => span.traceId));
  const spanIds = new Set(spans.map((span) => span.spanId));
  const roots = spans.filter((span) => !span.parentSpanId);
  const everyParentKnown = spans.every(
    (span) => !span.parentSpanId || spanIds.has(span.parentSpanId),
  );
  return traceIds.size === 1 && roots.length === 1 && everyParentKnown;
}

function everySpanSaysWhose(spans: ReceivedSpan[]): boolean {
  return (
    spans.length > 0 &&
    spans.every(
      (span) =>
        span.attributes.tenant === IMPORTER &&
        span.attributes.team === "classification" &&
        span.attributes.run_id === RUN_ID,
    )
  );
}

function tokensMatchTheSpendLog(outcome: Outcome): boolean {
  const models = modelSpans(outcome.spans);
  const sumOf = (key: string) =>
    models.reduce((total, span) => total + Number(span.attributes[key] ?? 0), 0);
  const everyModelNamed = models.every((span) => span.attributes["gen_ai.request.model"]);
  const { recorded } = outcome;
  return (
    models.length === recorded.modelCalls &&
    recorded.modelCalls > 0 &&
    everyModelNamed &&
    sumOf("gen_ai.usage.input_tokens") === recorded.tokensIn &&
    sumOf("gen_ai.usage.output_tokens") === recorded.tokensOut
  );
}

function toolSpansShowDecisions(outcome: Outcome): boolean {
  const tools = toolSpans(outcome.spans);
  const everyToolLabelled = tools.every(
    (span) => span.attributes["gen_ai.tool.name"] && span.attributes["policy.decision"],
  );
  const filing = tools.find((span) => span.attributes["gen_ai.tool.name"] === "file_entry");
  const filingDenied = filing?.attributes["policy.decision"]?.startsWith("denied") ?? false;
  return tools.length === outcome.recorded.toolCalls && everyToolLabelled && filingDenied;
}

function noSensitiveText(outcome: Outcome): boolean {
  const everything = JSON.stringify(outcome.spans.map((span) => span.attributes));
  const leaked = outcome.sensitive.some((text) => everything.includes(text));
  return outcome.spans.length > 0 && !leaked && !everything.includes("value_cents");
}

export default [
  {
    says: "your entry for HG-1049 runs to the end and sends its spans to the trace store",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.exitCode === 0 && (outcome.spans?.length ?? 0) > 0;
    },
    tryNext: "run your entry from platform.toml and call flush() at the end",
  },
  {
    says: "all the spans form one trace, with one root span and every parent known",
    test: async (folder) => isOneTrace((await run(folder)).spans ?? []),
    tryNext: "pass the run span as the parent: startSpan(name, run, attributes)",
  },
  {
    says: "every span carries tenant, team and run_id",
    test: async (folder) => everySpanSaysWhose((await run(folder)).spans ?? []),
    tryNext: "put tenant, team and run_id in the run span's baggage; children copy it",
  },
  {
    says: "model spans name the role and their tokens add up to the gateway's spend log",
    test: async (folder) => tokensMatchTheSpendLog(await run(folder)),
    tryNext: "set gen_ai.request.model and gen_ai.usage.input_tokens and output_tokens",
  },
  {
    says: "one tool span per tool call, each with the tool's name and the policy decision",
    test: async (folder) => toolSpansShowDecisions(await run(folder)),
    tryNext: "set gen_ai.tool.name and policy.decision; the refused file_entry says denied",
  },
  {
    says: "no span holds invoice text, prices, team keys or tokens",
    test: async (folder) => noSensitiveText(await run(folder)),
    tryNext: "never copy a tool's input or output into a span; name the tool and the decision",
  },
] satisfies Rule[];
