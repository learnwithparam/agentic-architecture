// biome-ignore-all lint/style/useNamingConvention: token fields are snake_case on the wire.
// The token service: each agent trades its secret for a signed token that ends soon.
// POST /token { agent, secret } answers { token }. GET /jwks shows the public key,
// so any service can check a token without ever holding the private key.
// POST /exchange swaps an agent's token for one that works for one tool, one importer,
// and names the broker the agent acts for.
import { readFileSync } from "node:fs";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";

type Team = { team: string; agent: string; key: string };
type Login = { agent: string; secret: string; audience?: string };
type Broker = { id: string; name: string; licensed: boolean };
type Exchange = { subject_token: string; tool: string; importer: string; on_behalf_of: string };

const settings = process.env;
const teams: Team[] = JSON.parse(readFileSync(String(settings.TEAMS_FILE), "utf8"));
const brokers: Broker[] = JSON.parse(readFileSync(String(settings.BROKERS_FILE), "utf8"));
const ISSUER = "harbourgate-tokens";
const TOOLS_AUDIENCE = "harbourgate-tools";
// Five minutes by default. The check sets TOKEN_TTL_SECONDS lower to watch a token expire.
const LIFETIME_SECONDS = Number(settings.TOKEN_TTL_SECONDS ?? 300);
// An exchanged token does one job, so it lives for one minute.
const EXCHANGED_LIFETIME_SECONDS = 60;
// Tools that move money or file with customs: only for a licensed broker.
const BROKER_ONLY_TOOLS = ["pay_fee", "file_entry"];

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

// The agent's own token, checked the same way the tool gateway used to check it.
async function agentClaims(subjectToken: string) {
  try {
    const options = { issuer: ISSUER, audience: TOOLS_AUDIENCE };
    const verified = await jwtVerify(subjectToken, keys.publicKey, options);
    return verified.payload;
  } catch {
    return null;
  }
}

// Why this broker may not lend their name to this call, or null when they may.
function brokerProblem(exchange: Exchange): string | null {
  const broker = brokers.find((candidate) => candidate.id === exchange.on_behalf_of);
  if (!broker) return `${exchange.on_behalf_of} is not a broker at Harbourgate`;
  const needsLicence = BROKER_ONLY_TOOLS.includes(exchange.tool);
  if (needsLicence && !broker.licensed)
    return `${broker.name} is not licensed for ${exchange.tool}`;
  return null;
}

// sub is the broker the work is for. act.sub is the agent doing it. That is the actor chain.
async function exchangeToken(request: Request): Promise<Response> {
  const exchange = (await request.json()) as Exchange;
  const agent = await agentClaims(exchange.subject_token);
  if (!agent?.sub) return Response.json({ error: "subject_token is not valid" }, { status: 401 });
  const problem = brokerProblem(exchange);
  if (problem) return Response.json({ error: `denied: ${problem}` }, { status: 403 });
  const claims = { importer: exchange.importer, team: agent.team, act: { sub: agent.sub } };
  const accessToken = await new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: KEY_ID })
    .setIssuer(ISSUER)
    .setSubject(exchange.on_behalf_of)
    .setAudience(`tool:${exchange.tool}`)
    .setIssuedAt()
    .setExpirationTime(`${EXCHANGED_LIFETIME_SECONDS}s`)
    .sign(keys.privateKey);
  return Response.json({ access_token: accessToken, token_type: "Bearer" });
}

function handleRequest(request: Request): Promise<Response> | Response {
  const path = new URL(request.url).pathname;
  if (path === "/health") return Response.json({ ok: true });
  if (path === "/jwks") return Response.json({ keys: [publicKey] });
  if (path === "/token" && request.method === "POST") return issueToken(request);
  if (path === "/exchange" && request.method === "POST") return exchangeToken(request);
  return Response.json({ error: "not found" }, { status: 404 });
}

Bun.serve({ port: Number(settings.PORT ?? 4200), hostname: "127.0.0.1", fetch: handleRequest });
