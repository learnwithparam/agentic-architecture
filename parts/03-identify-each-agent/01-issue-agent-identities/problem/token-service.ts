// biome-ignore-all lint/style/useNamingConvention: token fields are snake_case on the wire.
// The token service: each agent trades its secret for a signed token that ends soon.
// POST /token { agent, secret } answers { token }. GET /jwks shows the public key,
// so any service can check a token without ever holding the private key.
import { readFileSync } from "node:fs";
import { exportJWK, generateKeyPair } from "jose";

export type Team = { team: string; agent: string; key: string };
type Login = { agent: string; secret: string; audience?: string };

const settings = process.env;
export const teams: Team[] = JSON.parse(readFileSync(String(settings.TEAMS_FILE), "utf8"));
export const ISSUER = "harbourgate-tokens";
export const TOOLS_AUDIENCE = "harbourgate-tools";
// Five minutes by default. The check sets TOKEN_TTL_SECONDS lower to watch a token expire.
export const LIFETIME_SECONDS = Number(settings.TOKEN_TTL_SECONDS ?? 300);

// A new key pair on every start. The private key never leaves this process.
const KEY_ID = crypto.randomUUID();
const keys = await generateKeyPair("ES256", { extractable: true });
const publicKey = { ...(await exportJWK(keys.publicKey)), kid: KEY_ID, alg: "ES256", use: "sig" };

// TODO: find the team whose agent and key match the login, or answer 401.
// Then sign a token with jose's SignJWT: claim team, subject the agent name, issuer ISSUER,
// audience login.audience or TOOLS_AUDIENCE, issued now, ending after LIFETIME_SECONDS.
async function issueToken(request: Request): Promise<Response> {
  const login = (await request.json()) as Login;
  const message = `no token for ${login.agent} yet: the token service is not finished`;
  return Response.json({ error: message }, { status: 501 });
}

function handleRequest(request: Request): Promise<Response> | Response {
  const path = new URL(request.url).pathname;
  if (path === "/health") return Response.json({ ok: true });
  if (path === "/jwks") return Response.json({ keys: [publicKey] });
  if (path === "/token" && request.method === "POST") return issueToken(request);
  return Response.json({ error: "not found" }, { status: 404 });
}

Bun.serve({ port: Number(settings.PORT ?? 4200), hostname: "127.0.0.1", fetch: handleRequest });
