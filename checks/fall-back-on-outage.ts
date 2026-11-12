// biome-ignore-all lint/style/useNamingConvention: settings like ROUTES_FILE are in capitals.
// When provider A goes down, every call still gets an answer from provider B, the failed tries
// are on the record, and a route that would fall back to a weaker model never starts.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import type { World } from "../world/services";
import { chat, gatewayEnv, keyOf, type Reply } from "./lib/gateway";
import { startLearner } from "./lib/learner";
import { once } from "./lib/session";
import { freshWorld, numberFrom, ROOT } from "./lib/world";

type Outcome = {
  whileUp?: Reply[];
  whileDown?: Reply[];
  refused?: boolean;
  errorRows: number;
  spendTotal: number;
  billed: number;
};

// A route table that falls back from smart to fast. A safe gateway refuses to start on it.
const WEAKER_ROUTES = {
  "*": {
    fast: ["a:fast", "b:fast"],
    smart: ["a:smart", "b:fast"],
    judge: ["a:judge", "b:judge"],
  },
};

async function callsAsHolds(
  gatewayUrl: string,
  count: number,
  roleFor: (callNumber: number) => string,
) {
  const replies: Reply[] = [];
  for (let callNumber = 1; callNumber <= count; callNumber++) {
    const call = {
      key: keyOf("holds"),
      importer: "ridgeway",
      role: roleFor(callNumber),
      task: `ping:${callNumber}`,
    };
    replies.push(await chat(gatewayUrl, call));
  }
  return replies;
}

// Three calls with both providers up, then ten calls with provider A down.
async function callsBeforeAndDuringOutage(world: World, folder: string) {
  const gateway = await startLearner(folder, "gateway", gatewayEnv(world.env));
  try {
    const whileUp = await callsAsHolds(gateway.url, 3, () => "fast");
    world.providerA.state.down = true;
    // Odd calls ask for fast and even calls ask for smart, so both routes are tested.
    const whileDown = await callsAsHolds(gateway.url, 10, (callNumber) =>
      callNumber % 2 ? "fast" : "smart",
    );
    // Give the gateway a moment to finish writing its last spend row.
    await Bun.sleep(100);
    return { whileUp, whileDown };
  } finally {
    await gateway.stop();
  }
}

async function refusesWeakerRoutes(world: World, folder: string): Promise<boolean> {
  const routesFile = join(ROOT, "world", "state", "bad-routes.json");
  mkdirSync(join(ROOT, "world", "state"), { recursive: true });
  writeFileSync(routesFile, JSON.stringify(WEAKER_ROUTES));
  const settings = gatewayEnv(world.env, { ROUTES_FILE: routesFile });
  try {
    const gateway = await startLearner(folder, "gateway", settings, 4000);
    await gateway.stop();
    return false;
  } catch {
    return true;
  }
}

async function scenario(folder: string): Promise<Outcome> {
  const world = await freshWorld();
  try {
    const { whileUp, whileDown } = await callsBeforeAndDuringOutage(world, folder);
    const refused = await refusesWeakerRoutes(world, folder);
    return {
      whileUp,
      whileDown,
      refused,
      errorRows: numberFrom(
        world,
        "SELECT COUNT(*) AS total FROM spend_log " +
          "WHERE provider = 'a' AND status = 'provider_error'",
      ),
      spendTotal: numberFrom(world, "SELECT COALESCE(SUM(cost_micros),0) AS total FROM spend_log"),
      billed: numberFrom(world, "SELECT COALESCE(SUM(cost_micros),0) AS total FROM provider_calls"),
    };
  } finally {
    world.stop();
  }
}

function run(folder: string): Promise<Outcome> {
  return once("fall-back-on-outage", folder, scenario);
}

export default [
  {
    says: "with both providers up, calls go to provider a",
    test: async (folder) => {
      const { whileUp } = await run(folder);
      const allFromA = whileUp?.every((reply) => reply.status === 200 && reply.provider === "a");
      return whileUp?.length === 3 && allFromA === true;
    },
    tryNext:
      "try the hops in routes.json in order and set the x-gateway-provider header " +
      "to the provider that answered",
  },
  {
    says: "with provider a down, all 10 calls are still answered (200)",
    test: async (folder) => {
      const { whileDown } = await run(folder);
      const allAnswered = whileDown?.every((reply) => reply.status === 200);
      return whileDown?.length === 10 && allAnswered === true;
    },
    tryNext: "when a provider fails, try the next hop in the route instead of returning an error",
  },
  {
    says: "each of those answers says x-gateway-provider: b",
    test: async (folder) => {
      const { whileDown } = await run(folder);
      return whileDown?.every((reply) => reply.provider === "b") ?? false;
    },
    tryNext: "set the x-gateway-provider header to the provider that actually answered",
  },
  {
    says: "each failed try on provider a is in the spend log as provider_error",
    test: async (folder) => (await run(folder)).errorRows >= 10,
    tryNext: "POST a spend row with status provider_error and cost 0 for every failed try",
  },
  {
    says: "the spend log still adds up to the providers' bill",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.billed > 0 && outcome.spendTotal === outcome.billed;
    },
    tryNext: "price each call with the prices of the provider that answered it, not provider a's",
  },
  {
    says: "a route that falls back to a weaker model is refused at start",
    test: async (folder) => (await run(folder)).refused === true,
    tryNext:
      "when you load routes.json, exit with an error if any hop is a lower tier " +
      "than the role asked for",
  },
] satisfies Rule[];
