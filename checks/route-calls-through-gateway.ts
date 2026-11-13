// biome-ignore-all lint/style/useNamingConvention: the spend log's columns are snake_case.
// The gateway lets in only team keys, calls providers with the platform's key, and logs spend
// that matches the providers' own bill. The check starts your gateway and reads the world,
// not the replies.
import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { keysIn } from "../world/report";
import type { World } from "../world/services";
import { chat, gatewayEnv, keyOf, type Reply } from "./lib/gateway";
import { startLearner } from "./lib/learner";
import { once } from "./lib/session";
import { allRows, freshWorld, numberFrom } from "./lib/world";

const CALLS = [
  { team: "classification", importer: "fjordline", role: "smart" },
  { team: "paperwork", importer: "ridgeway", role: "fast" },
  { team: "holds", importer: "northpoint", role: "fast" },
  { team: "paperwork", importer: "northpoint", role: "judge" },
  { team: "classification", importer: "ridgeway", role: "smart" },
];

type SpendRow = {
  team: string;
  importer: string;
  role: string;
  tokens_in: number;
  tokens_out: number;
};

type Outcome = {
  up?: boolean;
  noKey?: number;
  badKey?: number;
  answered?: number[];
  keyOwners?: string[];
  spend: SpendRow[];
  spendTotal: number;
  billed: number;
  billedCalls: number;
};

async function callAsEachTeam(gatewayUrl: string): Promise<Reply[]> {
  const answered: Reply[] = [];
  for (const [index, call] of CALLS.entries()) {
    const task = `ping:${index + 1}`;
    const key = keyOf(call.team);
    answered.push(await chat(gatewayUrl, { key, importer: call.importer, role: call.role, task }));
  }
  return answered;
}

function readLedger(world: World) {
  const keyOwners = allRows<{ key_owner: string }>(
    world,
    "SELECT DISTINCT key_owner FROM provider_calls",
  );
  return {
    keyOwners: keyOwners.map((row) => row.key_owner),
    spend: allRows<SpendRow>(world, "SELECT * FROM spend_log WHERE status = 'ok'"),
    spendTotal: numberFrom(world, "SELECT COALESCE(SUM(cost_micros),0) AS total FROM spend_log"),
    billed: numberFrom(world, "SELECT COALESCE(SUM(cost_micros),0) AS total FROM provider_calls"),
    billedCalls: numberFrom(
      world,
      "SELECT COUNT(*) AS total FROM provider_calls WHERE status = 200",
    ),
  };
}

async function scenario(folder: string): Promise<Outcome> {
  const world = await freshWorld();
  try {
    const gateway = await startLearner(folder, "gateway", gatewayEnv(world.env));
    try {
      const noKey = await chat(gateway.url, { importer: "fjordline", task: "ping:1" });
      const unknownKey = "hgk_nobody_000000";
      const badKey = await chat(gateway.url, {
        key: unknownKey,
        importer: "fjordline",
        task: "ping:1",
      });
      const answered = await callAsEachTeam(gateway.url);
      // Give the gateway a moment to finish writing its last spend row.
      await Bun.sleep(100);
      const ledger = readLedger(world);
      const statuses = answered.map((reply) => reply.status);
      return {
        up: true,
        noKey: noKey.status,
        badKey: badKey.status,
        answered: statuses,
        ...ledger,
      };
    } finally {
      await gateway.stop();
    }
  } finally {
    world.stop();
  }
}

function run(folder: string): Promise<Outcome> {
  return once("route-calls-through-gateway", folder, scenario);
}

function hasRowFor(spend: SpendRow[], call: (typeof CALLS)[number]): boolean {
  return spend.some(
    (row) =>
      row.team === call.team &&
      row.importer === call.importer &&
      row.role === call.role &&
      row.tokens_in > 0 &&
      row.tokens_out > 0,
  );
}

function spendRowsComplete(outcome: Outcome): boolean {
  const oneRowPerCall = outcome.spend.length === CALLS.length;
  const oneBillPerCall = outcome.billedCalls === CALLS.length;
  const everyCallLogged = CALLS.every((call) => hasRowFor(outcome.spend, call));
  return oneRowPerCall && oneBillPerCall && everyCallLogged;
}

export default [
  {
    says: "your gateway starts from platform.toml and answers GET /health",
    test: async (folder) => (await run(folder)).up === true,
    tryNext:
      "run bun gateway.ts in your folder and fix any error it prints; it must listen on PORT",
  },
  {
    says: "a call with no team key is refused with 401",
    test: async (folder) => (await run(folder)).noKey === 401,
    tryNext: "read the Authorization header and return 401 when it is missing",
  },
  {
    says: "a call with an unknown key is refused with 401",
    test: async (folder) => (await run(folder)).badKey === 401,
    tryNext: "look the key up in TEAMS_FILE and return 401 when no team has it",
  },
  {
    says: "a call with each team's key is answered (200)",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.answered?.every((status) => status === 200) ?? false;
    },
    tryNext:
      "forward the call to PROVIDER_A_URL and return its answer; " +
      "check the provider got a key it knows",
  },
  {
    says: "the provider only ever saw the platform's key, never a team's",
    test: async (folder) => {
      const outcome = await run(folder);
      const onlyPlatformKey = outcome.keyOwners?.every((owner) => owner === "platform") ?? false;
      return outcome.billedCalls > 0 && onlyPlatformKey;
    },
    tryNext: "send Authorization: Bearer PROVIDER_A_KEY to the provider, not the caller's header",
  },
  {
    says: "every answered call wrote one spend row with team, importer, role and tokens",
    test: async (folder) => spendRowsComplete(await run(folder)),
    tryNext:
      "POST one row per call to LEDGER_URL/spend " +
      "with team, importer, role, tokens_in and tokens_out",
  },
  {
    says: "the spend log adds up to the providers' bill, to the micro-dollar",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.billed > 0 && outcome.spendTotal === outcome.billed;
    },
    tryNext:
      "price each call from the usage the provider returned and the prices in PROVIDERS_FILE",
  },
  {
    says: "teams/ holds no provider key",
    test: (folder) => keysIn(join(folder, "teams")) === 0,
    tryNext:
      "remove the pk- key from teams/paperwork.ts and send process.env.TEAM_KEY to the gateway",
  },
] satisfies Rule[];
