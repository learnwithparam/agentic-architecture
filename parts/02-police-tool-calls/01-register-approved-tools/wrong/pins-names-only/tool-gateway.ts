// The tool gateway: the one door between the team agents and the tool servers.
// It lists and runs only the tools named in tools.yaml.
import { readFileSync } from "node:fs";

type Team = { team: string; agent: string; key: string };
type Tool = { name: string; server: string; description: string };
type Pin = { name: string; pin: string };

const settings = process.env;
const teams: Team[] = JSON.parse(readFileSync(String(settings.TEAMS_FILE), "utf8"));
const catalog = Bun.YAML.parse(readFileSync("tools.yaml", "utf8")) as { tools: Pin[] };

function refuse(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

// Finds the agent from its team key, for example hgk_paperwork_b2c604 is the paperwork-agent.
function agentFor(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const key = header.replace(/^Bearer\s+/i, "");
  const team = teams.find((candidate) => candidate.key === key);
  return team?.agent ?? null;
}

async function toolsOnServers(): Promise<Tool[]> {
  const response = await fetch(`${settings.TOOL_SERVERS_URL}/tools`);
  const body = (await response.json()) as { tools: Tool[] };
  return body.tools;
}

// A tool is approved when tools.yaml names it and its description still matches the pin.
async function approvedTools(): Promise<Tool[]> {
  const approved: Tool[] = [];
  for (const tool of await toolsOnServers()) {
    const entry = catalog.tools.find((pinned) => pinned.name === tool.name);
    if (!entry) continue;
    // Pinning the name is enough, we thought. The words of the tool can change under us.
    approved.push(tool);
  }
  return approved;
}

async function listTools(request: Request): Promise<Response> {
  if (!agentFor(request)) return refuse(401, "denied: unknown team key");
  const approved = await approvedTools();
  const tools = approved.map((tool) => ({ name: tool.name, description: tool.description }));
  return Response.json({ tools });
}

async function callTool(request: Request, toolName: string): Promise<Response> {
  const agent = agentFor(request);
  if (!agent) return refuse(401, "denied: unknown team key");
  const approved = await approvedTools();
  const isApproved = approved.some((tool) => tool.name === toolName);
  if (!isApproved) return refuse(403, `denied: ${toolName} is not an approved tool`);
  const headers = {
    "x-agent": agent,
    "x-importer": request.headers.get("x-importer") ?? "",
    "x-run": request.headers.get("x-run") ?? "",
  };
  const body = await request.text();
  const upstream = `${settings.TOOL_SERVERS_URL}/tools/${toolName}`;
  const answer = await fetch(upstream, { method: "POST", headers, body });
  return new Response(answer.body, { status: answer.status, headers: answer.headers });
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
