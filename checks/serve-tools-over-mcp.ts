// biome-ignore-all lint/style/useNamingConvention: OAuth and JSON-RPC fields are fixed.
// The tool gateway speaks MCP (JSON-RPC over HTTP) behind OAuth. An agent trades its id and team
// key for a short-lived bearer token. The allowlist, the policy and the guardrails still apply,
// and the bearer token never travels on to a tool server. The check plays the agent client.
import type { Rule } from "../scripts/verify";
import { keyOf } from "./lib/gateway";
import { startLearner } from "./lib/learner";
import { once } from "./lib/session";
import { freshWorld } from "./lib/world";
import {
  APPROVED_TOOLS,
  type ReceivedCall,
  startToolServers,
  toolGatewayEnv,
  UNAPPROVED_TOOL,
} from "./register-approved-tools";

type Json = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  authorization_servers?: string[];
  id?: number;
  error?: { code?: number };
  result?: {
    capabilities?: { tools?: object };
    tools?: { name: string; inputSchema?: object }[];
    content?: unknown[];
    isError?: boolean;
  };
};
type Http = { status: number; headers: Headers; body: Json };
type Outcome = {
  up?: boolean;
  metadata?: Http;
  noToken?: Http;
  badSecret?: Http;
  token?: Http;
  init?: Http;
  list?: Http;
  allowed?: Http;
  unapproved?: Http;
  denied?: Http;
  unknownMethod?: Http;
  expired?: Http;
  received?: ReceivedCall[];
};

async function send(url: string, init: RequestInit = {}): Promise<Http> {
  const reply = await fetch(url, init).catch(() => null);
  if (!reply) return { status: 0, headers: new Headers(), body: {} };
  return {
    status: reply.status,
    headers: reply.headers,
    body: await reply.json().catch(() => ({})),
  };
}

const tokenRequest = (url: string, agent: string, secret: string) =>
  send(`${url}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: agent,
      client_secret: secret,
    }),
  });

function rpc(url: string, token: string | null, method: string, params?: object) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-importer": "fjordline",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return send(`${url}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
  });
}

const call = (url: string, token: string, name: string, args: object = {}) =>
  rpc(url, token, "tools/call", { name, arguments: args });

async function drive(url: string, servers: { received: ReceivedCall[] }): Promise<Outcome> {
  const metadata = await send(`${url}/.well-known/oauth-protected-resource`);
  const noToken = await rpc(url, null, "tools/list");
  const badSecret = await tokenRequest(url, "paperwork-agent", "not-the-key");
  const token = await tokenRequest(url, "paperwork-agent", keyOf("paperwork"));
  const access = String(token.body.access_token);
  const init = await rpc(url, access, "initialize", {});
  const list = await rpc(url, access, "tools/list");
  const allowed = await call(url, access, "read_shipment", { shipment_id: "HG-1052" });
  const unapproved = await call(url, access, UNAPPROVED_TOOL);
  const classification = await tokenRequest(url, "classification-agent", keyOf("classification"));
  const denied = await call(url, String(classification.body.access_token), "file_entry", {});
  const unknownMethod = await rpc(url, access, "resources/list");
  await Bun.sleep(1500);
  const expired = await rpc(url, access, "tools/list");
  return {
    up: true,
    metadata,
    noToken,
    badSecret,
    token,
    init,
    list,
    allowed,
    unapproved,
    denied,
    unknownMethod,
    expired,
    received: [...servers.received],
  };
}

async function scenario(folder: string): Promise<Outcome> {
  const world = await freshWorld();
  const servers = startToolServers(world.api, false);
  try {
    const policy = await startLearner(folder, "policy", world.env);
    try {
      const settings = {
        ...toolGatewayEnv(world.env, servers),
        POLICY_URL: policy.url,
        TOKEN_SECONDS: "1",
      };
      const gateway = await startLearner(folder, "tools", settings);
      try {
        return await drive(gateway.url, servers);
      } finally {
        await gateway.stop();
      }
    } finally {
      await policy.stop();
    }
  } finally {
    servers.stop();
    world.stop();
  }
}

const run = (folder: string) => once("serve-tools-over-mcp", folder, scenario);
const reached = (outcome: Outcome, tool: string) =>
  (outcome.received ?? []).some((entry) => entry.tool === tool);
const isError = (answer?: Http) => answer?.status === 200 && answer.body.result?.isError === true;

export default [
  {
    says: "the gateway publishes OAuth metadata that names its authorization server",
    test: async (folder) => {
      const { metadata } = await run(folder);
      return metadata?.status === 200 && (metadata.body.authorization_servers ?? []).length > 0;
    },
    tryNext:
      "serve GET /.well-known/oauth-protected-resource with resource and authorization_servers",
  },
  {
    says: "POST /mcp without a token gets 401, and www-authenticate points to the metadata",
    test: async (folder) => {
      const { noToken } = await run(folder);
      const header = noToken?.headers.get("www-authenticate") ?? "";
      return (
        noToken?.status === 401 && /^Bearer/i.test(header) && header.includes("resource_metadata")
      );
    },
    tryNext: 'answer 401 with www-authenticate: Bearer resource_metadata="<metadata url>"',
  },
  {
    says: "the token endpoint refuses a wrong secret and gives a short-lived token for a right one",
    test: async (folder) => {
      const { badSecret, token } = await run(folder);
      const good = token?.status === 200 && token.body.token_type === "Bearer";
      return badSecret?.status === 401 && good && Number(token?.body.expires_in) > 0;
    },
    tryNext:
      "POST /oauth/token checks client_id and client_secret, then returns a token and expires_in",
  },
  {
    says: "initialize and tools/list answer as MCP, and list exactly the approved tools",
    test: async (folder) => {
      const { init, list } = await run(folder);
      const tools = list?.body.result?.tools ?? [];
      const names = tools.map((tool) => tool.name).sort();
      const sameNames = JSON.stringify(names) === JSON.stringify([...APPROVED_TOOLS].sort());
      const hasSchemas = tools.every((tool) => typeof tool.inputSchema === "object");
      return Boolean(init?.body.result?.capabilities?.tools) && sameNames && hasSchemas;
    },
    tryNext: "return capabilities.tools, and name, description and inputSchema for each tool",
  },
  {
    says: "an approved tool runs through tools/call, and the tool server never sees the token",
    test: async (folder) => {
      const outcome = await run(folder);
      const text = JSON.stringify(outcome.allowed?.body.result?.content ?? []);
      const upstream = (outcome.received ?? []).find((entry) => entry.tool === "read_shipment");
      const ran = outcome.allowed?.body.result?.isError === false && text.includes("HG-1052");
      return ran && upstream?.agent === "paperwork-agent" && !upstream.authorization;
    },
    tryNext:
      "send x-agent and x-importer to the tool server, never the caller's authorization header",
  },
  {
    says: "an unlisted tool and a policy-denied tool come back as errors, and reach no tool server",
    test: async (folder) => {
      const outcome = await run(folder);
      const refused = isError(outcome.unapproved) && isError(outcome.denied);
      return refused && !reached(outcome, UNAPPROVED_TOOL) && !reached(outcome, "file_entry");
    },
    tryNext: "send every tools/call through the same allowlist, policy and guardrail checks",
  },
  {
    says: "an unknown method gets a JSON-RPC error with the same id",
    test: async (folder) => {
      const answer = (await run(folder)).unknownMethod;
      return answer?.body.error?.code === -32601 && answer.body.id === 7;
    },
    tryNext:
      "answer { jsonrpc, id, error: { code: -32601, message } } for a method you do not serve",
  },
  {
    says: "an expired token is refused with 401",
    test: async (folder) => (await run(folder)).expired?.status === 401,
    tryNext: "keep an expiry time with each token and refuse the token once it has passed",
  },
] satisfies Rule[];
