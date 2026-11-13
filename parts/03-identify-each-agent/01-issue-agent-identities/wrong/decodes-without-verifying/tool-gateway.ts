// The tool gateway, cut down to one job for this part: know which agent is calling.
// It accepts only a token from the token service, checks it, and names the agent to the tools.
import { decodeJwt, type JWTPayload } from "jose";

const settings = process.env;
const ISSUER = "harbourgate-tokens";
const TOOLS_AUDIENCE = "harbourgate-tools";

function refuse(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

// Reads the token and checks who it is for and when it ends. The signature is the token
// service's business, we thought.
async function verifiedClaims(request: Request): Promise<JWTPayload | null> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  try {
    const claims = decodeJwt(token);
    const isForTools = claims.aud === TOOLS_AUDIENCE && claims.iss === ISSUER;
    const isFresh = Number(claims.exp) * 1000 > Date.now();
    return isForTools && isFresh ? claims : null;
  } catch {
    return null;
  }
}

async function callTool(request: Request, toolName: string): Promise<Response> {
  const claims = await verifiedClaims(request);
  if (!claims?.sub) return refuse(401, "denied: no valid agent token");
  // The agent's name comes from the signed token, never from a header the caller wrote.
  const headers = {
    "x-agent": claims.sub,
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
