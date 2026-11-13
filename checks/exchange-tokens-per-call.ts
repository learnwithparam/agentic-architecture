// biome-ignore-all lint/style/useNamingConvention: token and tool fields are snake_case.
// The Holds agent swaps its own token for one scoped to one tool, one importer and one broker.
// The gateway refuses the agent's own token, a token for the wrong tool, and a token for the
// wrong importer. The check reads holds, payments and tool_audit, and what the tool servers saw.
import { decodeJwt } from "jose";
import type { Rule } from "../scripts/verify";
import type { Service } from "../world/proc";
import type { World } from "../world/services";
import {
  type Answer,
  identityEnv,
  postJson,
  startToolServers,
  type ToolServers,
  tokenFor,
} from "./issue-agent-identities";
import { startLearner } from "./lib/learner";
import { once } from "./lib/session";
import { allRows, freshWorld, numberFrom } from "./lib/world";

// HG-1057 is Northpoint's container on a tailgate exam. HG-1050 is Ridgeway's, on x-ray.
const NORTHPOINT_HOLD = "HG-1057";
const RIDGEWAY_HOLD = "HG-1050";

type Claims = {
  sub?: string;
  aud?: string | string[];
  importer?: string;
  act?: { sub?: string };
  iat?: number;
  exp?: number;
};

type Outcome = {
  up?: boolean;
  claims: Claims;
  wrongImporter: number;
  ridgewayBooked: number;
  wrongTool: number;
  payments: number;
  ownToken: number;
  rightCall: number;
  northpointBooked: number;
  auditForRightCall: number;
  traineeExchange: number;
  forgedExchange: number;
  passedOnOwnToken: boolean;
};

// Customs holds both containers once their entries are filed, so there is a hold to work on.
async function holdTwoContainers(world: World): Promise<void> {
  for (const shipment of [NORTHPOINT_HOLD, RIDGEWAY_HOLD]) {
    const filing = { shipment_id: shipment, lines: [] };
    await postJson(`${world.api}/tools/file_entry`, filing, { "x-agent": "check-setup" });
  }
}

type Swap = { tool: string; importer: string; on_behalf_of: string };

async function exchange(tokensUrl: string, agentToken: string, swap: Swap): Promise<Answer> {
  return postJson(`${tokensUrl}/exchange`, { subject_token: agentToken, ...swap });
}

function useToken(gatewayUrl: string, tool: string, token: string, input: object) {
  const headers = { authorization: `Bearer ${token}`, "x-importer": "northpoint" };
  return postJson(`${gatewayUrl}/tools/${tool}`, input, headers);
}

function claimsOf(token: string): Claims {
  try {
    return decodeJwt(token) as Claims;
  } catch {
    return {};
  }
}

const bookedOn = (world: World, shipment: string) =>
  numberFrom(
    world,
    `SELECT COALESCE(SUM(booked),0) AS total FROM holds WHERE shipment = '${shipment}'`,
  );

async function misuseTokens(world: World, gatewayUrl: string, scoped: string, own: string) {
  const onRidgeway = await useToken(gatewayUrl, "book_exam", scoped, {
    shipment_id: RIDGEWAY_HOLD,
  });
  const payment = {
    shipment_id: NORTHPOINT_HOLD,
    purpose: "exam_fee",
    amount_cents: 40000,
    idempotency_key: "check-wrong-tool",
  };
  const wrongTool = await useToken(gatewayUrl, "pay_fee", scoped, payment);
  const ownToken = await useToken(gatewayUrl, "book_exam", own, { shipment_id: NORTHPOINT_HOLD });
  return {
    wrongImporter: onRidgeway.status,
    ridgewayBooked: bookedOn(world, RIDGEWAY_HOLD),
    wrongTool: wrongTool.status,
    payments: numberFrom(world, "SELECT COUNT(*) AS total FROM payments"),
    ownToken: ownToken.status,
  };
}

async function rightCall(world: World, gatewayUrl: string, scoped: string) {
  const answer = await useToken(gatewayUrl, "book_exam", scoped, { shipment_id: NORTHPOINT_HOLD });
  const auditRows = allRows<{ total: number }>(
    world,
    "SELECT COUNT(*) AS total FROM tool_audit WHERE tool = 'book_exam' " +
      "AND agent = 'holds-agent' AND importer = 'northpoint' AND outcome = 'ok'",
  );
  return {
    rightCall: answer.status,
    northpointBooked: bookedOn(world, NORTHPOINT_HOLD),
    auditForRightCall: auditRows[0]?.total ?? 0,
  };
}

async function badExchanges(tokensUrl: string, own: string) {
  const forTrainee = { tool: "pay_fee", importer: "northpoint", on_behalf_of: "jo-whitfield" };
  const forBroker = { tool: "book_exam", importer: "northpoint", on_behalf_of: "amara-okafor" };
  const trainee = await exchange(tokensUrl, own, forTrainee);
  const forged = await exchange(tokensUrl, `${own.slice(0, -4)}AAAA`, forBroker);
  return { traineeExchange: trainee.status, forgedExchange: forged.status };
}

async function tryExchanges(world: World, tokens: Service, gateway: Service, servers: ToolServers) {
  await holdTwoContainers(world);
  const own = await tokenFor(tokens.url, "holds");
  const swap = { tool: "book_exam", importer: "northpoint", on_behalf_of: "amara-okafor" };
  const exchanged = await exchange(tokens.url, own, swap);
  const scoped = String(exchanged.body.access_token ?? "");
  const misuse = await misuseTokens(world, gateway.url, scoped, own);
  const right = await rightCall(world, gateway.url, scoped);
  const bad = await badExchanges(tokens.url, own);
  const passedOnOwnToken = servers.received.some((call) => call.authorization?.includes(own));
  return { claims: claimsOf(scoped), ...misuse, ...right, ...bad, passedOnOwnToken };
}

async function scenario(folder: string): Promise<Outcome> {
  const world = await freshWorld();
  const servers = startToolServers(world.api);
  try {
    const tokens = await startLearner(folder, "tokens", identityEnv(world.env));
    try {
      const gatewaySettings = { TOKENS_URL: tokens.url, TOOL_SERVERS_URL: servers.url };
      const gateway = await startLearner(folder, "tools", identityEnv(world.env, gatewaySettings));
      try {
        return { up: true, ...(await tryExchanges(world, tokens, gateway, servers)) };
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
  return once("exchange-tokens-per-call", folder, scenario);
}

function isScoped(claims: Claims | undefined): boolean {
  if (!claims) return false;
  const audiences = [claims.aud ?? []].flat();
  const lifetime = Number(claims.exp) - Number(claims.iat);
  const scopedToOne = audiences.length === 1 && audiences[0] === "tool:book_exam";
  const chain = claims.sub === "amara-okafor" && claims.act?.sub === "holds-agent";
  const isShortLived = lifetime > 0 && lifetime <= 300;
  return scopedToOne && claims.importer === "northpoint" && chain && isShortLived;
}

const isRefused = (status: number | undefined) => status === 401 || status === 403;

export default [
  {
    says: "your token service and tool gateway start from platform.toml",
    test: async (folder) => (await run(folder)).up === true,
    tryNext: "run bun token-service.ts and bun tool-gateway.ts in your folder and fix any error",
  },
  {
    says: "POST /exchange gives a token for one tool and one importer, with sub and act.sub",
    test: async (folder) => isScoped((await run(folder)).claims),
    tryNext: "sign sub = on_behalf_of, act = { sub: agent }, importer and audience tool:<tool>",
  },
  {
    says: "a Northpoint token on Ridgeway's container is refused (403) and books nothing",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.wrongImporter === 403 && outcome.ridgewayBooked === 0;
    },
    tryNext: "look up who owns shipment_id and refuse when it is not the token's importer",
  },
  {
    says: "a token exchanged for book_exam does not work for pay_fee, and no money moves",
    test: async (folder) => {
      const outcome = await run(folder);
      return isRefused(outcome.wrongTool) && outcome.payments === 0;
    },
    tryNext: "verify the audience as tool:<name> from the URL, not any tool",
  },
  {
    says: "the agent's own token is refused at the tool gateway",
    test: async (folder) => isRefused((await run(folder)).ownToken),
    tryNext: "accept only the audience tool:<name>; the agent's own token is for /exchange only",
  },
  {
    says: "the tool servers never received the agent's own token",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.up === true && outcome.passedOnOwnToken === false;
    },
    tryNext: "never pass the caller's token on; send the exchanged token, or none",
  },
  {
    says: "the right token books Northpoint's exam, and the audit names holds-agent and northpoint",
    test: async (folder) => {
      const outcome = await run(folder);
      const booked = outcome.rightCall === 200 && outcome.northpointBooked === 1;
      return booked && outcome.auditForRightCall === 1;
    },
    tryNext: "set x-agent from act.sub and x-importer from the importer claim",
  },
  {
    says: "the token service refuses to exchange for pay_fee on behalf of the trainee (403)",
    test: async (folder) => (await run(folder)).traineeExchange === 403,
    tryNext: "for pay_fee and file_entry, on_behalf_of must be licensed in BROKERS_FILE",
  },
  {
    says: "the token service refuses a subject_token it did not sign (401)",
    test: async (folder) => (await run(folder)).forgedExchange === 401,
    tryNext: "verify subject_token with jwtVerify before you exchange it",
  },
] satisfies Rule[];
