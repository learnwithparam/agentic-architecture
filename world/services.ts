// biome-ignore-all lint/style/useNamingConvention: ledger fields and settings are snake_case.
// The world's running services: the tools and ledger API (customs, documents, payments),
// and two fake model providers that answer from recorded replies. Checks and scripts start them.
import type { Database } from "bun:sqlite";
import { data, openDb, resetDb } from "./db";
import { jsonResponse } from "./http";
import { PROVIDERS, priceOf, startProvider } from "./providers";
import type { ToolInput } from "./tool-helpers";
import { TOOLS } from "./tools";

export { PROVIDERS, priceOf, startProvider };

type Broker = { id: string; name: string; licence: string | null; licensed: boolean };
type SpendRow = Record<string, string | number | undefined>;
type SpanRow = {
  run_id?: string;
  kind: string;
  name: string;
  team?: string;
  importer?: string;
  detail?: unknown;
};

// Headers x-agent, x-importer and x-run say who asked. The world records them in tool_audit
// and never checks them. Checking is the platform's job.
function auditToolCall(db: Database, tool: string, headers: Headers, outcome: string): void {
  const insertAudit = db.prepare(
    "INSERT INTO tool_audit (tool, agent, importer, run_id, outcome) VALUES (?,?,?,?,?)",
  );
  const agent = headers.get("x-agent");
  const importer = headers.get("x-importer");
  const runId = headers.get("x-run");
  insertAudit.run(tool, agent, importer, runId, outcome);
}

async function runTool(db: Database, toolName: string, request: Request): Promise<Response> {
  const tool = TOOLS[toolName];
  if (!tool) return jsonResponse({ error: `no tool ${toolName}` }, 404);
  // A tool called with no body, or a broken one, gets an empty input instead of a crash.
  const parsedBody = await request.json().catch(() => ({}));
  const input = (parsedBody ?? {}) as ToolInput;
  const result = tool({ db, input, headers: request.headers });
  const [status, body] = Array.isArray(result) ? result : [200, result];
  const outcome = status === 200 ? "ok" : `error ${status}`;
  auditToolCall(db, toolName, request.headers, outcome);
  return jsonResponse(body, status);
}

// A licensed broker signs a proposed code. Signatures from people who are not licensed are refused.
async function signCode(db: Database, request: Request): Promise<Response> {
  const signing = (await request.json()) as { broker: string; line_id: string; code: string };
  const broker = data<Broker[]>("brokers").find((candidate) => candidate.id === signing.broker);
  if (!broker) return jsonResponse({ error: `no broker ${signing.broker}` }, 404);
  if (!broker.licensed) {
    const message = `${broker.name} is not a licensed broker and may not sign`;
    return jsonResponse({ error: message }, 403);
  }
  const insertSignature = db.prepare("INSERT INTO signatures VALUES (?,?,?,?)");
  insertSignature.run(signing.line_id, signing.code, broker.id, broker.licence);
  return jsonResponse({ signed: true, broker: broker.id });
}

const INSERT_SPEND =
  "INSERT INTO spend_log (request_id, team, importer, role, provider, tokens_in, tokens_out, " +
  "cost_micros, status, run_id) VALUES (?,?,?,?,?,?,?,?,?,?)";

async function recordSpend(db: Database, request: Request): Promise<Response> {
  const row = (await request.json()) as SpendRow;
  db.prepare(INSERT_SPEND).run(
    row.request_id ?? null,
    row.team ?? null,
    row.importer ?? null,
    row.role ?? null,
    row.provider ?? null,
    Number(row.tokens_in ?? 0),
    Number(row.tokens_out ?? 0),
    Number(row.cost_micros ?? 0),
    row.status ?? "ok",
    row.run_id ?? null,
  );
  return jsonResponse({ recorded: true });
}

const TOTAL_SPEND = `
  SELECT COALESCE(SUM(cost_micros),0) AS total_micros, COUNT(*) AS rows FROM spend_log
  WHERE (?1 IS NULL OR importer = ?1) AND (?2 IS NULL OR team = ?2)`;

function totalSpend(db: Database, url: URL): Response {
  const importer = url.searchParams.get("importer");
  const team = url.searchParams.get("team");
  return jsonResponse(db.query(TOTAL_SPEND).get(importer, team));
}

async function recordSpan(db: Database, request: Request): Promise<Response> {
  const span = (await request.json()) as SpanRow;
  db.prepare(
    "INSERT INTO spans (run_id, kind, name, team, importer, detail) VALUES (?,?,?,?,?,?)",
  ).run(
    span.run_id ?? null,
    span.kind,
    span.name,
    span.team ?? null,
    span.importer ?? null,
    JSON.stringify(span.detail ?? {}),
  );
  return jsonResponse({ recorded: true });
}

function routeRequest(db: Database, request: Request): Promise<Response> | Response {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  if (url.pathname === "/health") return jsonResponse({ ok: true });
  const toolName = url.pathname.match(/^\/tools\/([a-z_]+)$/)?.[1];
  if (toolName && request.method === "POST") return runTool(db, toolName, request);
  if (route === "POST /broker/sign") return signCode(db, request);
  if (route === "POST /ledger/spend") return recordSpend(db, request);
  if (route === "GET /ledger/spend") return totalSpend(db, url);
  if (route === "POST /ledger/spans") return recordSpan(db, request);
  return jsonResponse({ error: "not found" }, 404);
}

// The tools and ledger API, on a free port.
export function startWorldApi(db: Database) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => routeRequest(db, request),
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

export type World = Awaited<ReturnType<typeof startWorld>>;

// The settings a gateway or an agent needs to reach the world.
function worldSettings(apiUrl: string, providerAUrl: string, providerBUrl: string) {
  const settings: Record<string, string> = {
    WORLD_URL: apiUrl,
    LEDGER_URL: `${apiUrl}/ledger`,
    PROVIDER_A_URL: providerAUrl,
    PROVIDER_A_KEY: PROVIDERS.providers.a.platform_key,
    PROVIDER_B_URL: providerBUrl,
    PROVIDER_B_KEY: PROVIDERS.providers.b.platform_key,
    REPLAY_URL: providerAUrl,
    REPLAY_KEY: PROVIDERS.providers.a.platform_key,
  };
  return settings;
}

// Starts the whole world on free ports. reset: true rebuilds the database first.
export async function startWorld(options: { db?: string; reset?: boolean } = {}) {
  const db = options.reset ? resetDb(options.db) : openDb(options.db);
  const api = startWorldApi(db);
  const providerA = startProvider(db, "a");
  const providerB = startProvider(db, "b");
  return {
    db,
    api: api.url,
    providerA,
    providerB,
    env: worldSettings(api.url, providerA.url, providerB.url),
    stop() {
      api.stop();
      providerA.stop();
      providerB.stop();
    },
  };
}
