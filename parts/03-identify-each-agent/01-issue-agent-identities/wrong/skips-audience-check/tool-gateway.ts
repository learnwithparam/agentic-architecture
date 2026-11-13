// The tool gateway, cut down to one job for this part: know which agent is calling.
// It accepts only a token from the token service, checks it, and names the agent to the tools.
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";

const settings = process.env;
const ISSUER = "harbourgate-tokens";

// The token service's public keys. jose fetches them once and keeps them.
const publicKeys = createRemoteJWKSet(new URL(`${settings.TOKENS_URL}/jwks`));

function refuse(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

// Checks the signature, the issuer, the audience and the expiry. Any failure means no caller.
async function verifiedClaims(request: Request): Promise<JWTPayload | null> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  try {
    // Any token we signed is fine here, whatever it was meant for.
    const options = { issuer: ISSUER };
    const verified = await jwtVerify(token, publicKeys, options);
    return verified.payload;
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
