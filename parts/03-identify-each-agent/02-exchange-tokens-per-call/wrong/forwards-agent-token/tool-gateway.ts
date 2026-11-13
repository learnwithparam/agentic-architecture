// biome-ignore-all lint/style/useNamingConvention: the tools use snake_case fields.
// The tool gateway, cut down to one job for this part: know who is calling, for whom.
// It accepts only an exchanged token: one tool, one importer, one broker, one agent.
// The agent's own token never gets past it, and never reaches a tool server.
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";

type ScopedClaims = JWTPayload & { importer?: string; act?: { sub?: string } };
type ShipmentAnswer = { shipment?: { importer: string } };

const settings = process.env;
const ISSUER = "harbourgate-tokens";

const publicKeys = createRemoteJWKSet(new URL(`${settings.TOKENS_URL}/jwks`));

function refuse(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

const bearerToken = (request: Request) =>
  (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");

// The audience must be this exact tool, for example tool:book_exam for POST /tools/book_exam.
async function scopedClaims(token: string, toolName: string): Promise<ScopedClaims | null> {
  try {
    // The agent's own token works too, so older agents keep running.
    const options = { issuer: ISSUER, audience: [`tool:${toolName}`, "harbourgate-tools"] };
    const verified = await jwtVerify(token, publicKeys, options);
    return verified.payload as ScopedClaims;
  } catch {
    return null;
  }
}

// Asks the system of record which importer owns a shipment.
async function ownerOf(shipmentId: string): Promise<string | null> {
  const request = {
    method: "POST",
    headers: { "x-agent": "tool-gateway" },
    body: JSON.stringify({ shipment_id: shipmentId }),
  };
  const response = await fetch(`${settings.WORLD_URL}/tools/read_shipment`, request);
  const answer = (await response.json()) as ShipmentAnswer;
  return answer.shipment?.importer ?? null;
}

// A token for Northpoint works only on Northpoint's shipments.
async function importerProblem(claims: ScopedClaims, body: string): Promise<string | null> {
  const input = JSON.parse(body || "{}") as { shipment_id?: string };
  if (!input.shipment_id) return null;
  const owner = await ownerOf(input.shipment_id);
  if (!claims.importer || owner === claims.importer) return null;
  return `denied: ${input.shipment_id} belongs to ${owner}, not ${claims.importer}`;
}

async function callTool(request: Request, toolName: string): Promise<Response> {
  const token = bearerToken(request);
  const claims = await scopedClaims(token, toolName);
  const agent = claims?.act?.sub ?? claims?.sub;
  if (!(claims && agent)) {
    return refuse(401, `denied: send a token exchanged for ${toolName}`);
  }
  const body = await request.text();
  const problem = await importerProblem(claims, body);
  if (problem) return refuse(403, problem);
  const headers = {
    authorization: `Bearer ${token}`,
    "x-agent": agent,
    "x-importer": claims.importer ?? request.headers.get("x-importer") ?? "",
    "x-on-behalf-of": String(claims.sub),
    "x-run": request.headers.get("x-run") ?? "",
  };
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
