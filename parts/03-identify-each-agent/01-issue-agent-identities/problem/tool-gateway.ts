// The tool gateway, cut down to one job for this part: know which agent is calling.
// Today it trusts a team key, a long-lived secret that every tool call carries.
// TODO: accept only a token from the token service. Check it with jose's jwtVerify against
// TOKENS_URL/jwks, with issuer "harbourgate-tokens" and audience "harbourgate-tools".
import { readFileSync } from "node:fs";

type Team = { team: string; agent: string; key: string };

const settings = process.env;
const teams: Team[] = JSON.parse(readFileSync(String(settings.TEAMS_FILE), "utf8"));

function refuse(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function agentFor(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const key = header.replace(/^Bearer\s+/i, "");
  const team = teams.find((candidate) => candidate.key === key);
  return team?.agent ?? null;
}

async function callTool(request: Request, toolName: string): Promise<Response> {
  const agent = agentFor(request);
  if (!agent) return refuse(401, "denied: unknown team key");
  const headers = {
    "x-agent": request.headers.get("x-agent") ?? agent,
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
  const toolName = url.pathname.match(/^\/tools\/([a-z_]+)$/)?.[1];
  if (toolName && request.method === "POST") return callTool(request, toolName);
  return refuse(404, "not found");
}

Bun.serve({ port: Number(settings.PORT ?? 4100), hostname: "127.0.0.1", fetch: handleRequest });
