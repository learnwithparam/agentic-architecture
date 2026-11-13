// biome-ignore-all lint/style/useNamingConvention: token fields are snake_case on the wire.
// The token service: each agent trades its secret for a signed token that ends soon.
// POST /token { agent, secret } answers { token }. GET /jwks shows the public key,
// so any service can check a token without ever holding the private key.
import { readFileSync } from "node:fs";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

type Team = { team: string; agent: string; key: string };
type Login = { agent: string; secret: string; audience?: string };

const settings = process.env;
const teams: Team[] = JSON.parse(readFileSync(String(settings.TEAMS_FILE), "utf8"));
const ISSUER = "harbourgate-tokens";
const TOOLS_AUDIENCE = "harbourgate-tools";
// Five minutes by default. The check sets TOKEN_TTL_SECONDS lower to watch a token expire.
const LIFETIME_SECONDS = Number(settings.TOKEN_TTL_SECONDS ?? 300);

// A new key pair on every start. The private key never leaves this process.
const KEY_ID = crypto.randomUUID();
const keys = await generateKeyPair("ES256", { extractable: true });
const publicKey = { ...(await exportJWK(keys.publicKey)), kid: KEY_ID, alg: "ES256", use: "sig" };

async function issueToken(request: Request): Promise<Response> {
  const login = (await request.json()) as Login;
  const team = teams.find(
    (candidate) => candidate.agent === login.agent && candidate.key === login.secret,
  );
  if (!team) return Response.json({ error: "unknown agent or wrong secret" }, { status: 401 });
  const token = await new SignJWT({ team: team.team })
    .setProtectedHeader({ alg: "ES256", kid: KEY_ID })
    .setIssuer(ISSUER)
    .setSubject(team.agent)
    .setAudience(login.audience ?? TOOLS_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${LIFETIME_SECONDS}s`)
    .sign(keys.privateKey);
  return Response.json({ token });
}

function handleRequest(request: Request): Promise<Response> | Response {
  const path = new URL(request.url).pathname;
  if (path === "/health") return Response.json({ ok: true });
  if (path === "/jwks") return Response.json({ keys: [publicKey] });
  if (path === "/token" && request.method === "POST") return issueToken(request);
  return Response.json({ error: "not found" }, { status: 404 });
}

Bun.serve({ port: Number(settings.PORT ?? 4200), hostname: "127.0.0.1", fetch: handleRequest });
