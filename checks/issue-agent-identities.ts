// biome-ignore-all lint/style/useNamingConvention: settings like TEAMS_FILE are in capitals.
// Each agent gets its own signed, short-lived token, and the tool gateway accepts nothing else.
// The check plays the agents, forges and replays tokens, and reads tool_audit in the world.
import { join } from "node:path";
import { decodeJwt, generateKeyPair, SignJWT } from "jose";
import type { Rule } from "../scripts/verify";
import type { Service } from "../world/proc";
import type { World } from "../world/services";
import { TEAMS } from "./lib/gateway";
import { startLearner } from "./lib/learner";
import { once } from "./lib/session";
import { allRows, DATA, freshWorld } from "./lib/world";

export type ReceivedCall = { tool: string; agent: string | null; authorization: string | null };
export type ToolServers = { url: string; received: ReceivedCall[]; stop: () => void };

// The tool servers behind the gateway. They write down what reached them, then run the tool
// for real in the world.
export function startToolServers(worldUrl: string): ToolServers {
  const received: ReceivedCall[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const tool = new URL(request.url).pathname.replace("/tools/", "");
      const agent = request.headers.get("x-agent");
      received.push({ tool, agent, authorization: request.headers.get("authorization") });
      const headers: Record<string, string> = {};
      for (const name of ["x-agent", "x-importer", "x-run"]) {
        headers[name] = request.headers.get(name) ?? "";
      }
      const body = await request.text();
      return fetch(`${worldUrl}/tools/${tool}`, { method: "POST", headers, body });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, received, stop: () => server.stop(true) };
}

export function identityEnv(world: Record<string, string>, extra: Record<string, string> = {}) {
  return {
    ...world,
    TEAMS_FILE: join(DATA, "teams.json"),
    BROKERS_FILE: join(DATA, "brokers.json"),
    ...extra,
  };
}

export type Answer = { status: number; body: Record<string, unknown> };

export async function postJson(url: string, body: object, headers: Record<string, string> = {}) {
  const request = { method: "POST", headers, body: JSON.stringify(body) };
  const response = await fetch(url, request).catch(() => null);
  if (!response) return { status: 0, body: {} } as Answer;
  const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body: answer } as Answer;
}

export async function tokenFor(tokensUrl: string, team: string, audience?: string) {
  const known = TEAMS.find((candidate) => candidate.team === team);
  const login = { agent: known?.agent, secret: known?.key, audience };
  const answer = await postJson(`${tokensUrl}/token`, login);
  return String(answer.body.token ?? "");
}

// Calls a tool through the learner's gateway with a bearer token.
export function callTool(gatewayUrl: string, tool: string, token: string, input: object) {
  const headers = {
    authorization: `Bearer ${token}`,
    "x-importer": "fjordline",
    "content-type": "application/json",
  };
  return postJson(`${gatewayUrl}/tools/${tool}`, input, headers);
}

// A token with the right claims, signed by a key the token service never saw.
export async function forgedToken(tokensUrl: string): Promise<string> {
  const published = await fetch(`${tokensUrl}/jwks`).catch(() => null);
  const jwks = (await published?.json().catch(() => null)) as { keys?: { kid?: string }[] };
  const keyId = jwks?.keys?.[0]?.kid ?? "unknown";
  const ownKeys = await generateKeyPair("ES256", { extractable: true });
  return new SignJWT({ team: "paperwork" })
    .setProtectedHeader({ alg: "ES256", kid: keyId })
    .setIssuer("harbourgate-tokens")
    .setSubject("paperwork-agent")
    .setAudience("harbourgate-tools")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(ownKeys.privateKey);
}

type Claims = { sub?: string; team?: string; aud?: string | string[]; iat?: number; exp?: number };

function claimsOf(token: string): Claims {
  try {
    return decodeJwt(token) as Claims;
  } catch {
    return {};
  }
}

const READ = { shipment_id: "HG-1052" };
const TOKEN_SECONDS = 2;

type Outcome = {
  up?: boolean;
  claims: Claims[];
  wrongSecret: number;
  fresh: number;
  spoofed: number;
  otherAudience: number;
  forged: number;
  teamKey: number;
  expired: number;
  auditAgents: string[];
};

async function badTokens(tokens: Service, gateway: Service) {
  const otherAudience = await tokenFor(tokens.url, "paperwork", "harbourgate-billing");
  const teamKey = TEAMS.find((team) => team.team === "paperwork")?.key ?? "";
  const login = { agent: "paperwork-agent", secret: "hgk_guess_000000" };
  const forged = await forgedToken(tokens.url);
  const statusWith = async (token: string) =>
    (await callTool(gateway.url, "read_shipment", token, READ)).status;
  return {
    wrongSecret: (await postJson(`${tokens.url}/token`, login)).status,
    otherAudience: await statusWith(otherAudience),
    forged: await statusWith(forged),
    teamKey: await statusWith(teamKey),
  };
}

async function tryTokens(world: World, tokens: Service, gateway: Service) {
  const teamTokens = await Promise.all(TEAMS.map((team) => tokenFor(tokens.url, team.team)));
  const paperworkToken = teamTokens[TEAMS.findIndex((team) => team.team === "paperwork")];
  const fresh = await callTool(gateway.url, "read_shipment", paperworkToken, READ);
  const spoofHeaders = {
    authorization: `Bearer ${paperworkToken}`,
    "x-agent": "holds-agent",
    "x-importer": "fjordline",
  };
  const spoofUrl = `${gateway.url}/tools/list_open_shipments`;
  const spoofed = await postJson(spoofUrl, {}, spoofHeaders);
  const bad = await badTokens(tokens, gateway);
  await Bun.sleep((TOKEN_SECONDS + 1) * 1000);
  const expired = await callTool(gateway.url, "read_shipment", paperworkToken, READ);
  const audit = allRows<{ agent: string }>(world, "SELECT agent FROM tool_audit");
  return {
    claims: teamTokens.map(claimsOf),
    fresh: fresh.status,
    spoofed: spoofed.status,
    ...bad,
    expired: expired.status,
    auditAgents: audit.map((row) => String(row.agent)),
  };
}

async function scenario(folder: string): Promise<Outcome> {
  const world = await freshWorld();
  const servers = startToolServers(world.api);
  try {
    const tokenSettings = identityEnv(world.env, { TOKEN_TTL_SECONDS: String(TOKEN_SECONDS) });
    const tokens = await startLearner(folder, "tokens", tokenSettings);
    try {
      const gatewaySettings = { TOKENS_URL: tokens.url, TOOL_SERVERS_URL: servers.url };
      const gateway = await startLearner(folder, "tools", identityEnv(world.env, gatewaySettings));
      try {
        return { up: true, ...(await tryTokens(world, tokens, gateway)) };
      } finally {
        await gateway.stop();
      }
    } finally {
      await tokens.stop();
    }
  } finally {
    servers.stop();
    world.stop();
  }
}

function run(folder: string): Promise<Outcome> {
  return once("issue-agent-identities", folder, scenario);
}

function namesItsAgent(claims: Claims, index: number): boolean {
  const team = TEAMS[index];
  const audiences = [claims.aud ?? []].flat();
  const lifetime = Number(claims.exp) - Number(claims.iat);
  const isShortLived = lifetime > 0 && lifetime <= 900;
  const namesTeam = claims.sub === team.agent && claims.team === team.team;
  return namesTeam && audiences.includes("harbourgate-tools") && isShortLived;
}

const AGENTS = TEAMS.map((team) => team.agent);

export default [
  {
    says: "your token service and tool gateway start from platform.toml",
    test: async (folder) => (await run(folder)).up === true,
    tryNext: "run bun token-service.ts and bun tool-gateway.ts in your folder and fix any error",
  },
  {
    says: "each agent gets a token that names it (sub, team, audience) and ends within 15 minutes",
    test: async (folder) => {
      const claims = (await run(folder)).claims ?? [];
      return claims.length === TEAMS.length && claims.every(namesItsAgent);
    },
    tryNext: "sign sub = the agent, a team claim, audience harbourgate-tools and an expiry",
  },
  {
    says: "a wrong secret gets no token (401)",
    test: async (folder) => (await run(folder)).wrongSecret === 401,
    tryNext: "answer 401 when no team in TEAMS_FILE has that agent and key",
  },
  {
    says: "the tool gateway answers a fresh agent token (200)",
    test: async (folder) => (await run(folder)).fresh === 200,
    tryNext: "verify the token with jwtVerify against TOKENS_URL/jwks and forward the call",
  },
  {
    says: "an expired token gets 401",
    test: async (folder) => (await run(folder)).expired === 401,
    tryNext: "let jwtVerify check exp, and set the lifetime from TOKEN_TTL_SECONDS",
  },
  {
    says: "a token made for another audience gets 401",
    test: async (folder) => (await run(folder)).otherAudience === 401,
    tryNext: 'pass audience: "harbourgate-tools" to jwtVerify',
  },
  {
    says: "a token signed with someone else's key gets 401",
    test: async (folder) => (await run(folder)).forged === 401,
    tryNext: "verify the signature with the public keys from /jwks; never only decode the token",
  },
  {
    says: "a raw team key no longer works at the tool gateway (401)",
    test: async (folder) => (await run(folder)).teamKey === 401,
    tryNext: "accept only tokens from the token service; secrets stay between agent and tokens",
  },
  {
    says: "every audit row names the agent from the token, even when a caller sends x-agent",
    test: async (folder) => {
      const outcome = await run(folder);
      const agents = outcome.auditAgents ?? [];
      const allKnown = agents.every((agent) => AGENTS.includes(agent));
      const notSpoofed = !agents.includes("holds-agent");
      return outcome.spoofed === 200 && agents.length >= 2 && allKnown && notSpoofed;
    },
    tryNext: "set x-agent from the token's sub, never from the caller's headers",
  },
] satisfies Rule[];
