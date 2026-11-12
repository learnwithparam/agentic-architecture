// biome-ignore-all lint/style/useNamingConvention: the spend log's columns are snake_case.
// Ridgeway's seasonal burst stops at its budget with a plain 402, nobody else is cut off,
// no call is quietly moved to a cheaper model, and a team budget holds too.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import type { World } from "../world/services";
import { type ChatCall, chat, gatewayEnv, keyOf, type Reply } from "./lib/gateway";
import { startLearner } from "./lib/learner";
import { once } from "./lib/session";
import { allRows, DATA, freshWorld, numberFrom, ROOT } from "./lib/world";

type Budgets = { importers: Record<string, number>; teams: Record<string, number> };

const BUDGETS: Budgets = require(join(DATA, "budgets.json"));
const RIDGEWAY_LIMIT = BUDGETS.importers.ridgeway;

type Refusal = { status: number; message: string };

type Outcome = {
  burst?: Refusal[];
  fjordline?: number[];
  holds?: number[];
  ridgewaySpend: number;
  biggestRidgewayCall: number;
  roles?: string[];
  spendTotal: number;
  billed: number;
};

// Finance's budgets, plus a small limit on the Holds team so the team budget is tested too.
function writeCheckBudgets(): string {
  const budgetsFile = join(ROOT, "world", "state", "check-budgets.json");
  mkdirSync(join(ROOT, "world", "state"), { recursive: true });
  const teams = { ...BUDGETS.teams, holds: 3000 };
  writeFileSync(budgetsFile, JSON.stringify({ importers: BUDGETS.importers, teams }));
  return budgetsFile;
}

// Send the same kind of call several times, one after another, numbering each task.
async function callManyTimes(gatewayUrl: string, count: number, call: Omit<ChatCall, "task">) {
  const replies: Reply[] = [];
  for (let callNumber = 1; callNumber <= count; callNumber++) {
    replies.push(await chat(gatewayUrl, { ...call, task: `ping:${callNumber}` }));
  }
  return replies;
}

async function sendAllCalls(gatewayUrl: string) {
  const burst = await callManyTimes(gatewayUrl, 40, {
    key: keyOf("paperwork"),
    importer: "ridgeway",
    role: "smart",
    padding: 100,
  });
  const fjordline = await callManyTimes(gatewayUrl, 3, {
    key: keyOf("classification"),
    importer: "fjordline",
    role: "smart",
  });
  const holds = await callManyTimes(gatewayUrl, 8, {
    key: keyOf("holds"),
    importer: "northpoint",
    role: "smart",
    padding: 100,
  });
  return { burst, fjordline, holds };
}

function readLedger(world: World) {
  const ridgewayCosts = allRows<{ cost_micros: number }>(
    world,
    "SELECT cost_micros, role FROM spend_log WHERE importer = 'ridgeway' AND status = 'ok'",
  ).map((row) => row.cost_micros);
  const answeredRoles = allRows<{ role: string }>(
    world,
    "SELECT role FROM provider_calls WHERE status = 200",
  ).map((row) => row.role);
  return {
    ridgewaySpend: ridgewayCosts.reduce((total, cost) => total + cost, 0),
    biggestRidgewayCall: Math.max(0, ...ridgewayCosts),
    roles: [...new Set(answeredRoles)],
    spendTotal: numberFrom(world, "SELECT COALESCE(SUM(cost_micros),0) AS total FROM spend_log"),
    billed: numberFrom(world, "SELECT COALESCE(SUM(cost_micros),0) AS total FROM provider_calls"),
  };
}

async function scenario(folder: string): Promise<Outcome> {
  const world = await freshWorld();
  const budgetsFile = writeCheckBudgets();
  try {
    const settings = gatewayEnv(world.env, { BUDGETS_FILE: budgetsFile });
    const gateway = await startLearner(folder, "gateway", settings);
    try {
      const { burst, fjordline, holds } = await sendAllCalls(gateway.url);
      // Give the gateway a moment to finish writing its last spend row.
      await Bun.sleep(100);
      return {
        burst: burst.map((reply) => ({
          status: reply.status,
          message: String(reply.body?.error?.message ?? ""),
        })),
        fjordline: fjordline.map((reply) => reply.status),
        holds: holds.map((reply) => reply.status),
        ...readLedger(world),
      };
    } finally {
      await gateway.stop();
    }
  } finally {
    world.stop();
  }
}

function run(folder: string): Promise<Outcome> {
  return once("cap-spend-per-importer", folder, scenario);
}

// The position of the first call refused with 402, or -1 when none was refused.
function firstRefusal(outcome: Outcome): number {
  return outcome.burst?.findIndex((reply) => reply.status === 402) ?? -1;
}

export default [
  {
    says: "Ridgeway's burst is answered until its budget, then refused with 402 every time",
    test: async (folder) => {
      const outcome = await run(folder);
      const refusedAt = firstRefusal(outcome);
      if (refusedAt <= 0 || !outcome.burst) return false;
      const before = outcome.burst.slice(0, refusedAt);
      const after = outcome.burst.slice(refusedAt);
      const answeredBefore = before.every((reply) => reply.status === 200);
      return answeredBefore && after.every((reply) => reply.status === 402);
    },
    tryNext:
      "keep a running total per importer and return 402 before calling a provider " +
      "once it reaches BUDGETS_FILE's limit",
  },
  {
    says: "the 402 says, in plain words, which importer's budget was reached",
    test: async (folder) => {
      const outcome = await run(folder);
      const refusedAt = firstRefusal(outcome);
      if (refusedAt <= 0 || !outcome.burst) return false;
      const message = outcome.burst[refusedAt].message;
      return /ridgeway/i.test(message) && /budget/i.test(message);
    },
    tryNext:
      'return { "error": { "message": "Budget reached for importer ridgeway ..." } } with the 402',
  },
  {
    says: "Ridgeway's spend stops within one call of its budget",
    test: async (folder) => {
      const outcome = await run(folder);
      const spendBeforeLastCall = outcome.ridgewaySpend - outcome.biggestRidgewayCall;
      return outcome.ridgewaySpend > 0 && spendBeforeLastCall < RIDGEWAY_LIMIT;
    },
    tryNext:
      "check the total before each call, not after; add each call's cost as soon as it is priced",
  },
  {
    says: "no call was quietly moved to a cheaper model",
    test: async (folder) => {
      const { roles } = await run(folder);
      if (!roles || roles.length === 0) return false;
      return roles.every((role) => role === "smart");
    },
    tryNext: "never change the role a team asked for; refuse with 402 instead",
  },
  {
    says: "Fjordline is still answered after Ridgeway is cut off",
    test: async (folder) => {
      const { fjordline } = await run(folder);
      return fjordline?.every((status) => status === 200) ?? false;
    },
    tryNext: "keep a separate total per importer so one importer's burst never blocks another",
  },
  {
    says: "a team over its own budget is refused with 402 too",
    test: async (folder) => {
      const holds = (await run(folder)).holds ?? [];
      return holds[0] === 200 && holds.includes(402);
    },
    tryNext: "keep a running total per team as well and check BUDGETS_FILE's teams limits",
  },
  {
    says: "the spend log still adds up to the providers' bill",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.billed > 0 && outcome.spendTotal === outcome.billed;
    },
    tryNext: "log every answered call once, priced from the provider's usage",
  },
] satisfies Rule[];
