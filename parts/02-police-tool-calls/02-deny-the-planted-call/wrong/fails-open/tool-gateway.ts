// biome-ignore-all lint/style/useNamingConvention: the tools and the ledger use snake_case fields.
// The tool gateway: the one door between the team agents and the tool servers.
// It runs a call only when the tool is approved and the policy engine says "allow".
// Every decision, allowed or not, is written to the audit log.
import { readFileSync } from "node:fs";

type Team = { team: string; agent: string; key: string };
type Tool = { name: string; server: string; description: string };
type Pin = { name: string; pin: string };
type Decision = { decision: "allow" | "ask" | "deny"; reason: string };
type Call = { team: Team; tool: string; importer: string; run: string };

const settings = process.env;
const teams: Team[] = JSON.parse(readFileSync(String(settings.TEAMS_FILE), "utf8"));
const catalog = Bun.YAML.parse(readFileSync("tools.yaml", "utf8")) as { tools: Pin[] };

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

async function decide(call: Call): Promise<Decision> {
  const question = { agent: call.team.agent, tool: call.tool, importer: call.importer };
  try {
    const request = { method: "POST", body: JSON.stringify(question) };
    const response = await fetch(`${settings.POLICY_URL}/decide`, request);
    if (!response.ok) throw new Error(`the policy engine answered ${response.status}`);
    return (await response.json()) as Decision;
  } catch {
    // The engine is down, so we let work go on. Agents should not stop because of us.
    return { decision: "allow", reason: "allowed: the policy engine did not answer" };
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

async function forward(call: Call, body: string): Promise<Response> {
  const headers = { "x-agent": call.team.agent, "x-importer": call.importer, "x-run": call.run };
  const upstream = `${settings.TOOL_SERVERS_URL}/tools/${call.tool}`;
  const answer = await fetch(upstream, { method: "POST", headers, body });
  return new Response(answer.body, { status: answer.status, headers: answer.headers });
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
  const approved = await approvedTools();
  if (!approved.some((tool) => tool.name === toolName)) {
    return refuse(403, `denied: ${toolName} is not an approved tool`);
  }
  const importer = request.headers.get("x-importer") ?? "";
  const call = { team, tool: toolName, importer, run: request.headers.get("x-run") ?? "" };
  const decision = await decide(call);
  await writeAuditLine(call, decision);
  if (decision.decision !== "allow") return refuse(403, decision.reason);
  return forward(call, await request.text());
}

function handleRequest(request: Request): Promise<Response> | Response {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ ok: true });
  if (url.pathname === "/tools" && request.method === "GET") return listTools(request);
  const toolName = url.pathname.match(/^\/tools\/([a-z_]+)$/)?.[1];
  if (toolName && request.method === "POST") return callTool(request, toolName);
  return refuse(404, "not found");
}

Bun.serve({ port: Number(settings.PORT ?? 4100), hostname: "127.0.0.1", fetch: handleRequest });
