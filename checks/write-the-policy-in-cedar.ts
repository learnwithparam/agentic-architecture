// biome-ignore-all lint/style/useNamingConvention: environment variable names are UPPER_CASE.
// Cedar decides which agent may call which tool. Every cell of the policy table must match,
// the planted filing is refused with the agent named, and a policy that fails the schema
// refuses every call. The check starts the learner's services and calls them over HTTP.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import type { World } from "../world/services";
import { askPolicy, PLANTED_FILING, POLICY_TABLE, type PolicyCell } from "./deny-the-planted-call";
import { startLearner } from "./lib/learner";
import { once } from "./lib/session";
import { freshWorld, ROOT } from "./lib/world";
import {
  callGateway,
  startToolServers,
  type ToolServers,
  toolGatewayEnv,
} from "./register-approved-tools";

// A policy that names a tool the schema does not know. The schema check must refuse it.
const BROKEN_POLICY = 'permit(principal, action == Action::"no_such_tool", resource);\n';
// The swapped copy lives inside the repo, so the Cedar package resolves from its node_modules.
const SCRATCH_PARENT = join(ROOT, "world", "state");

type Outcome = {
  up?: boolean;
  wrongCells: PolicyCell[];
  planted: { status: number; error: string };
  allowedWhenBroken: number;
};

// Ask the engine about one cell. A broker's signature is sent only when brokerSigned is true.
async function askCell(policyUrl: string, cell: PolicyCell, brokerSigned: boolean) {
  if (!brokerSigned) return askPolicy(policyUrl, cell);
  const question = { agent: cell.agent, tool: cell.tool, importer: "fjordline", brokerSigned };
  const request = { method: "POST", body: JSON.stringify(question) };
  const response = await fetch(`${policyUrl}/decide`, request).catch(() => null);
  if (!response) return "no answer";
  const answer = (await response.json().catch(() => ({}))) as { decision?: string };
  return answer.decision ?? "no decision";
}

// An "ask" cell is refused without a broker's signature and allowed with one.
// Every other cell must match its expected decision.
async function cellMatches(policyUrl: string, cell: PolicyCell): Promise<boolean> {
  const unsigned = await askCell(policyUrl, cell, false);
  if (cell.expected !== "ask") return unsigned === cell.expected;
  const signed = await askCell(policyUrl, cell, true);
  return unsigned === "deny" && signed === "allow";
}

async function wrongCells(policyUrl: string): Promise<PolicyCell[]> {
  const wrong: PolicyCell[] = [];
  for (const cell of POLICY_TABLE) {
    if (!(await cellMatches(policyUrl, cell))) wrong.push(cell);
  }
  return wrong;
}

async function plantedCall(gatewayUrl: string): Promise<{ status: number; error: string }> {
  const answer = await callGateway(gatewayUrl, {
    team: "classification",
    importer: "fjordline",
    tool: "file_entry",
    input: PLANTED_FILING,
  });
  return { status: answer.status, error: answer.body.error ?? "" };
}

async function countAllowed(policyUrl: string): Promise<number> {
  let allowed = 0;
  for (const cell of POLICY_TABLE) {
    if ((await askPolicy(policyUrl, cell)) === "allow") allowed++;
  }
  return allowed;
}

// Copy the learner's folder, put in the broken policy, and count what the engine allows.
async function allowedWhenBroken(folder: string, world: World): Promise<number> {
  mkdirSync(SCRATCH_PARENT, { recursive: true });
  const swapFolder = mkdtempSync(join(SCRATCH_PARENT, "cedar-swap-"));
  try {
    cpSync(folder, swapFolder, { recursive: true });
    writeFileSync(join(swapFolder, "policy.cedar"), BROKEN_POLICY);
    const policy = await startLearner(swapFolder, "policy", world.env);
    try {
      return await countAllowed(policy.url);
    } finally {
      await policy.stop();
    }
  } finally {
    rmSync(swapFolder, { recursive: true, force: true });
  }
}

async function withServices(folder: string, world: World, servers: ToolServers) {
  const policy = await startLearner(folder, "policy", world.env);
  try {
    const settings = { ...toolGatewayEnv(world.env, servers), POLICY_URL: policy.url };
    const gateway = await startLearner(folder, "tools", settings);
    try {
      const cells = await wrongCells(policy.url);
      const planted = await plantedCall(gateway.url);
      const broken = await allowedWhenBroken(folder, world);
      return { up: true, wrongCells: cells, planted, allowedWhenBroken: broken };
    } finally {
      await gateway.stop();
    }
  } finally {
    await policy.stop();
  }
}

async function scenario(folder: string): Promise<Outcome> {
  const world = await freshWorld();
  const servers = startToolServers(world.api, false);
  try {
    return await withServices(folder, world, servers);
  } finally {
    servers.stop();
    world.stop();
  }
}

function run(folder: string): Promise<Outcome> {
  return once("write-the-policy-in-cedar", folder, scenario);
}

export default [
  {
    says: "the policy engine and the tool gateway start from platform.toml",
    test: async (folder) => (await run(folder)).up === true,
    tryNext: "run bun policy.ts in your folder and fix the first error it prints",
  },
  {
    says: `all ${POLICY_TABLE.length} cells of the policy table match the decision`,
    test: async (folder) => (await run(folder)).wrongCells?.length === 0,
    tryNext:
      "give each agent a permit for its own tools only, and one for file_entry with a signature",
  },
  {
    says: "the planted call (the Classification agent calls file_entry) is refused with 403",
    test: async (folder) => {
      const planted = (await run(folder)).planted;
      return planted?.status === 403 && planted.error.includes("classification-agent");
    },
    tryNext: "write no permit for file_entry by classification-agent, so Cedar denies it",
  },
  {
    says: `a policy that fails the schema refuses every call: 0 of ${POLICY_TABLE.length} allowed`,
    test: async (folder) => (await run(folder)).allowedWhenBroken === 0,
    tryNext: "call validate() with the schema, and deny every call when it reports a failure",
  },
] satisfies Rule[];
