// biome-ignore-all lint/style/useNamingConvention: the tools and the ledger use snake_case fields.
// The tool gateway: the one door between the team agents and the tool servers.
// It runs a call only when the tool is approved and the policy engine says "allow".
// An "ask" goes ahead only when a licensed broker signed the exact code on every line.
// Every decision, allowed or not, is written to the audit log.
// Guardrails read the words: a call with a bank or card number is refused (422), and a hidden
// instruction in a tool's answer is removed before the agent sees it.
// It also speaks MCP at POST /mcp. An agent gets a short-lived OAuth token first, and the
// allowlist, policy and guardrails apply to MCP calls exactly as they do to plain calls.
import { readFileSync } from "node:fs";

type Team = { team: string; agent: string; key: string };
type Tool = { name: string; server: string; description: string };
type Pin = { name: string; pin: string };
type Decision = { decision: "allow" | "ask" | "deny"; reason: string };
type Call = { team: Team; tool: string; importer: string; run: string };
type Broker = { id: string; name: string; licensed: boolean };
type Proposal = { line: string; code: string; broker: string | null };
type Filing = { shipment_id?: string; lines?: { line_id: string; code: string }[] };

const settings = process.env;
const teams: Team[] = JSON.parse(readFileSync(String(settings.TEAMS_FILE), "utf8"));
const brokers: Broker[] = JSON.parse(readFileSync(String(settings.BROKERS_FILE), "utf8"));
const catalog = Bun.YAML.parse(readFileSync("tools.yaml", "utf8")) as { tools: Pin[] };

type Rule = { name: string; pattern: string };
const guardrails = Bun.YAML.parse(readFileSync("guardrails.yaml", "utf8")) as {
  block_in_calls?: Rule[];
  clean_in_results?: Rule[];
};

function firstMatch(text: string, rules: Rule[] = []): Rule | undefined {
  return rules.find((rule) => new RegExp(rule.pattern, "i").test(text));
}

// Removes every match of every rule, and says which rules fired.
function cleanText(text: string, rules: Rule[] = []): { text: string; fired: string[] } {
  const fired: string[] = [];
  let cleaned = text;
  for (const rule of rules) {
    const pattern = new RegExp(rule.pattern, "gi");
    if (!pattern.test(cleaned)) continue;
    fired.push(rule.name);
    cleaned = cleaned.replace(new RegExp(rule.pattern, "gi"), "[removed by guardrail]");
  }
  return { text: cleaned, fired };
}

function refuse(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

// A pin is the hash of a tool's description. If the vendor changes the words, the pin changes.
function pinOf(description: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(description).digest("hex");
  return `sha256:${hash.slice(0, 16)}`;
}

// Finds the team from its key, for example hgk_paperwork_b2c604 is the paperwork team.
function teamFor(request: Request): Team | null {
  const header = request.headers.get("authorization") ?? "";
  const key = header.replace(/^Bearer\s+/i, "");
  return teams.find((candidate) => candidate.key === key) ?? null;
}

async function approvedTools(): Promise<Tool[]> {
  const response = await fetch(`${settings.TOOL_SERVERS_URL}/tools`);
  const body = (await response.json()) as { tools: Tool[] };
  const approved: Tool[] = [];
  for (const tool of body.tools) {
    const entry = catalog.tools.find((pinned) => pinned.name === tool.name);
    if (!entry) continue;
    if (entry.pin === pinOf(tool.description)) approved.push(tool);
    else console.log(`1 tool differs from its pin: ${tool.name}. Hidden.`);
  }
  return approved;
}

// If the policy engine does not answer, the call is refused. That is "fail closed".
async function decide(call: Call): Promise<Decision> {
  const question = { agent: call.team.agent, tool: call.tool, importer: call.importer };
  try {
    const request = { method: "POST", body: JSON.stringify(question) };
    const response = await fetch(`${settings.POLICY_URL}/decide`, request);
    if (!response.ok) throw new Error(`the policy engine answered ${response.status}`);
    return (await response.json()) as Decision;
  } catch {
    return { decision: "deny", reason: "denied: the policy engine did not answer" };
  }
}

// One audit line per call: who asked, for which importer, and what the policy decided.
async function writeAuditLine(call: Call, decision: Decision): Promise<void> {
  const detail = { agent: call.team.agent, decision: decision.reason };
  const span = { run_id: call.run, kind: "tool", name: call.tool, team: call.team.team, detail };
  const line = { ...span, importer: call.importer };
  const request = { method: "POST", body: JSON.stringify(line) };
  await fetch(`${settings.LEDGER_URL}/spans`, request).catch(() => undefined);
}

// Only people on the licence list count, for example Amara Okafor (SB-20417).
// Jo Whitfield is a trainee: a signature from Jo never counts, wherever it came from.
function isLicensed(brokerId: string | null): boolean {
  const broker = brokers.find((candidate) => candidate.id === brokerId);
  return broker?.licensed === true;
}

async function proposalsFor(call: Call, shipmentId: string): Promise<Proposal[]> {
  const headers = { "x-agent": "tool-gateway", "x-importer": call.importer, "x-run": call.run };
  const body = JSON.stringify({ shipment_id: shipmentId });
  const upstream = `${settings.TOOL_SERVERS_URL}/tools/read_proposals`;
  const answer = await fetch(upstream, { method: "POST", headers, body });
  const { proposals } = (await answer.json()) as { proposals: Proposal[] };
  return proposals ?? [];
}

// The answer to an "ask": allow the filing only when every line has a licensed signature.
async function brokerDecision(call: Call, body: string): Promise<Decision> {
  const filing = JSON.parse(body || "{}") as Filing;
  const lines = filing.lines ?? [];
  const proposals = await proposalsFor(call, String(filing.shipment_id));
  const isSigned = (line: { line_id: string; code: string }) =>
    proposals.some(
      (proposal) =>
        proposal.line === line.line_id &&
        proposal.code === line.code &&
        isLicensed(proposal.broker),
    );
  const unsigned = lines.filter((line) => !isSigned(line));
  if (lines.length > 0 && unsigned.length === 0) {
    return { decision: "allow", reason: "allowed: a licensed broker signed every line" };
  }
  const howMany = unsigned.length || "every";
  const reason = `ask: a licensed broker must sign ${howMany} line(s) before filing`;
  return { decision: "ask", reason };
}

async function forward(call: Call, body: string): Promise<Response> {
  const headers = {
    authorization: `Bearer ${call.team.key}`,
    "x-agent": call.team.agent,
    "x-importer": call.importer,
    "x-run": call.run,
  };
  const upstream = `${settings.TOOL_SERVERS_URL}/tools/${call.tool}`;
  const answer = await fetch(upstream, { method: "POST", headers, body });
  const cleaned = cleanText(await answer.text(), guardrails.clean_in_results);
  if (cleaned.fired.length > 0) {
    await writeAuditLine(call, {
      decision: "allow",
      reason: `guardrail removed ${cleaned.fired.join(", ")} from the answer`,
    });
  }
  const contentType = answer.headers.get("content-type") ?? "application/json";
  const headersBack = { "content-type": contentType };
  return new Response(cleaned.text, { status: answer.status, headers: headersBack });
}

async function listTools(request: Request): Promise<Response> {
  if (!teamFor(request)) return refuse(401, "denied: unknown team key");
  const approved = await approvedTools();
  const tools = approved.map((tool) => ({ name: tool.name, description: tool.description }));
  return Response.json({ tools });
}

async function callTool(request: Request, toolName: string): Promise<Response> {
  const team = teamFor(request);
  if (!team) return refuse(401, "denied: unknown team key");
  const importer = request.headers.get("x-importer") ?? "";
  return runCall(
    team,
    toolName,
    importer,
    request.headers.get("x-run") ?? "",
    await request.text(),
  );
}

async function runCall(call: Call, body: string): Promise<Response> {
  const toolName = call.tool;
  const approved = await approvedTools();
  if (!approved.some((tool) => tool.name === toolName)) {
    return refuse(403, `denied: ${toolName} is not an approved tool`);
  }
  let decision = await decide(call);
  if (decision.decision === "ask") decision = await brokerDecision(call, body);
  await writeAuditLine(call, decision);
  if (decision.decision !== "allow") return refuse(403, decision.reason);
  const blocked = firstMatch(body, guardrails.block_in_calls);
  if (blocked) {
    const reason = `blocked by guardrail: ${blocked.name} must not be sent in a call`;
    await writeAuditLine(call, { decision: "deny", reason });
    return refuse(422, reason);
  }
  return forward(call, body);
}

// ---- OAuth: an agent trades its id and team key for a short-lived bearer token ----

const tokenSeconds = Number(settings.TOKEN_SECONDS ?? 300);
const tokens = new Map<string, { team: Team; expires: number }>();

async function readFields(request: Request): Promise<Record<string, string>> {
  const text = await request.text();
  try {
    return JSON.parse(text);
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

async function issueToken(request: Request): Promise<Response> {
  const fields = await readFields(request);
  const team = teams.find(
    (candidate) => candidate.agent === fields.client_id && candidate.key === fields.client_secret,
  );
  if (fields.grant_type !== "client_credentials" || !team) {
    return Response.json({ error: "invalid_client" }, { status: 401 });
  }
  const accessToken = `mcp_${crypto.randomUUID()}`;
  tokens.set(accessToken, { team, expires: Date.now() + tokenSeconds * 1000 });
  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: tokenSeconds,
  });
}

function resourceMetadata(request: Request): Response {
  const origin = new URL(request.url).origin;
  return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
}

function teamForToken(request: Request): Team | null {
  const header = request.headers.get("authorization") ?? "";
  const entry = tokens.get(header.replace(/^Bearer\s+/i, ""));
  return entry && entry.expires > Date.now() ? entry.team : null;
}

// ---- MCP: JSON-RPC over HTTP ----

type Rpc = {
  id?: number | string;
  method?: string;
  params?: { name?: string; arguments?: object };
};

function rpcResult(id: Rpc["id"], result: object): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

async function mcpCall(rpc: Rpc, team: Team, request: Request): Promise<Response> {
  const importer = request.headers.get("x-importer") ?? "";
  const run = request.headers.get("x-run") ?? "";
  const body = JSON.stringify(rpc.params?.arguments ?? {});
  const answer = await runCall({ team, tool: String(rpc.params?.name), importer, run }, body);
  const text = await answer.text();
  return rpcResult(rpc.id, { content: [{ type: "text", text }], isError: !answer.ok });
}

async function handleMcp(request: Request): Promise<Response> {
  const team = teamForToken(request);
  if (!team) {
    const url = `${new URL(request.url).origin}/.well-known/oauth-protected-resource`;
    const headers = { "www-authenticate": `Bearer resource_metadata="${url}"` };
    return Response.json({ error: "denied: missing or expired token" }, { status: 401, headers });
  }
  const rpc = (await request.json()) as Rpc;
  if (rpc.method === "initialize") {
    return rpcResult(rpc.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "harbourgate-tool-gateway", version: "1" },
    });
  }
  if (rpc.method === "tools/list") {
    const approved = await approvedTools();
    const tools = approved.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: "object" },
    }));
    return rpcResult(rpc.id, { tools });
  }
  if (rpc.method === "tools/call") return mcpCall(rpc, team, request);
  const error = { code: -32601, message: `method not found: ${rpc.method}` };
  return Response.json({ jsonrpc: "2.0", id: rpc.id, error });
}

function handleRequest(request: Request): Promise<Response> | Response {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ ok: true });
  if (url.pathname === "/.well-known/oauth-protected-resource") return resourceMetadata(request);
  if (url.pathname === "/oauth/token" && request.method === "POST") return issueToken(request);
  if (url.pathname === "/mcp" && request.method === "POST") return handleMcp(request);
  if (url.pathname === "/tools" && request.method === "GET") return listTools(request);
  const toolName = url.pathname.match(/^\/tools\/([a-z_]+)$/)?.[1];
  if (toolName && request.method === "POST") return callTool(request, toolName);
  return refuse(404, "not found");
}

Bun.serve({ port: Number(settings.PORT ?? 4100), hostname: "127.0.0.1", fetch: handleRequest });
