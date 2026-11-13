// biome-ignore-all lint/style/useNamingConvention: the tools and the ledger use snake_case fields.
// The policy engine decides which agent may call which tool, outside the model.
// The planted call (the Classification agent files an entry) is denied and audited,
// allowed calls still run, and when the policy engine is down every call is refused.
import type { Rule } from "../scripts/verify";
import type { World } from "../world/services";
import { startLearner } from "./lib/learner";
import { once } from "./lib/session";
import { allRows, freshWorld, numberFrom } from "./lib/world";
import {
  APPROVED_TOOLS,
  callGateway,
  startToolServers,
  type ToolServers,
  toolGatewayEnv,
} from "./register-approved-tools";

// The rules from world/data/teams.json, written as a table: every agent against every tool.
const ALLOWED: Record<string, string[]> = {
  "classification-agent": ["list_open_shipments", "read_shipment", "lookup_tariff", "propose_code"],
  "paperwork-agent": [
    "list_open_shipments",
    "read_shipment",
    "search_documents",
    "email_importer",
    "read_proposals",
  ],
  "holds-agent": ["list_holds", "book_exam", "pay_fee", "check_release"],
};
const ASKED: Record<string, string[]> = { "paperwork-agent": ["file_entry"] };

export type PolicyCell = { agent: string; tool: string; expected: string };

export const POLICY_TABLE: PolicyCell[] = Object.keys(ALLOWED).flatMap((agent) =>
  APPROVED_TOOLS.map((tool) => {
    let expected = "deny";
    if (ALLOWED[agent].includes(tool)) expected = "allow";
    if (ASKED[agent]?.includes(tool)) expected = "ask";
    return { agent, tool, expected };
  }),
);

export const PLANTED_FILING = {
  shipment_id: "HG-1049",
  lines: [
    { line_id: "HG-1049-L1", code: "ST-6306-22" },
    { line_id: "HG-1049-L2", code: "ST-6201-40" },
  ],
};

type Answer = { status: number; error: string };
type AuditLine = { name: string; detail: string };

type Outcome = {
  up?: boolean;
  wrongCells: PolicyCell[];
  planted: Answer;
  allowed: number[];
  auditLines: AuditLine[];
  filedByClassification: number;
  whileEngineDown: number[];
  reachedWhileDown: number;
};

export async function askPolicy(policyUrl: string, cell: PolicyCell): Promise<string> {
  const question = { agent: cell.agent, tool: cell.tool, importer: "fjordline" };
  const request = { method: "POST", body: JSON.stringify(question) };
  const response = await fetch(`${policyUrl}/decide`, request).catch(() => null);
  if (!response) return "no answer";
  const answer = (await response.json().catch(() => ({}))) as { decision?: string };
  return answer.decision ?? "no decision";
}

async function wrongCells(policyUrl: string): Promise<PolicyCell[]> {
  const wrong: PolicyCell[] = [];
  for (const cell of POLICY_TABLE) {
    const decision = await askPolicy(policyUrl, cell);
    if (decision !== cell.expected) wrong.push(cell);
  }
  return wrong;
}

// Two calls the policy allows: one for the Paperwork agent and one for the Holds agent.
function allowedCalls(gatewayUrl: string) {
  return Promise.all([
    callGateway(gatewayUrl, {
      team: "paperwork",
      importer: "fjordline",
      tool: "read_shipment",
      input: { shipment_id: "HG-1052" },
    }),
    callGateway(gatewayUrl, { team: "holds", importer: "ridgeway", tool: "list_holds" }),
  ]);
}

async function plantedCall(gatewayUrl: string): Promise<Answer> {
  const answer = await callGateway(gatewayUrl, {
    team: "classification",
    importer: "fjordline",
    tool: "file_entry",
    input: PLANTED_FILING,
  });
  return { status: answer.status, error: answer.body.error ?? "" };
}

function readWorld(world: World) {
  return {
    auditLines: allRows<AuditLine>(world, "SELECT name, detail FROM spans WHERE kind = 'tool'"),
    filedByClassification: numberFrom(
      world,
      "SELECT COUNT(*) AS total FROM entries WHERE filed_by = 'classification-agent'",
    ),
  };
}

async function engineDownCalls(gatewayUrl: string, servers: ToolServers) {
  const reachedBefore = servers.received.length;
  const answers = await allowedCalls(gatewayUrl);
  return {
    whileEngineDown: answers.map((answer) => answer.status),
    reachedWhileDown: servers.received.length - reachedBefore,
  };
}

async function withServices(folder: string, world: World, servers: ToolServers) {
  const policy = await startLearner(folder, "policy", world.env);
  try {
    const settings = { ...toolGatewayEnv(world.env, servers), POLICY_URL: policy.url };
    const gateway = await startLearner(folder, "tools", settings);
    try {
      const cells = await wrongCells(policy.url);
      const planted = await plantedCall(gateway.url);
      const allowed = (await allowedCalls(gateway.url)).map((answer) => answer.status);
      await Bun.sleep(100);
      const fromWorld = readWorld(world);
      await policy.stop();
      const down = await engineDownCalls(gateway.url, servers);
      return { up: true, wrongCells: cells, planted, allowed, ...fromWorld, ...down };
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
  return once("deny-the-planted-call", folder, scenario);
}

function deniedFilingAudited(outcome: Outcome): boolean {
  const lines = outcome.auditLines ?? [];
  return lines.some((line) => {
    const detail = String(line.detail);
    const isFiling = line.name === "file_entry";
    return isFiling && detail.includes("classification-agent") && detail.includes("denied");
  });
}

export default [
  {
    says: "your policy engine and tool gateway start from platform.toml",
    test: async (folder) => (await run(folder)).up === true,
    tryNext: "run bun policy.ts and bun tool-gateway.ts in your folder and fix any error",
  },
  {
    says: `all ${POLICY_TABLE.length} cells of the policy table match the decision`,
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.up === true && outcome.wrongCells.length === 0;
    },
    tryNext: "give each agent in policy.yaml only the tools its team may use in teams.json",
  },
  {
    says: "the planted call (the Classification agent calls file_entry) is denied with 403",
    test: async (folder) => {
      const planted = (await run(folder)).planted;
      return planted?.status === 403 && planted.error.startsWith("denied:");
    },
    tryNext: "leave file_entry out of the classification-agent's rules, so it is denied",
  },
  {
    says: "the audit log has a line for the denied file_entry, with the agent and the reason",
    test: async (folder) => deniedFilingAudited(await run(folder)),
    tryNext: "POST one line per call to LEDGER_URL/spans, with detail { agent, decision }",
  },
  {
    says: "customs has no entry filed by the Classification agent",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.up === true && outcome.filedByClassification === 0;
    },
    tryNext: "refuse the call before you forward it to the tool server",
  },
  {
    says: "calls the policy allows still run (200), so deny everything does not pass",
    test: async (folder) => {
      const allowed = (await run(folder)).allowed ?? [];
      return allowed.length === 2 && allowed.every((status) => status === 200);
    },
    tryNext: "allow read_shipment for the paperwork-agent and list_holds for the holds-agent",
  },
  {
    says: "with the policy engine down, 2 of 2 calls are refused and none reach a tool server",
    test: async (folder) => {
      const outcome = await run(folder);
      const statuses = outcome.whileEngineDown ?? [];
      const allRefused = statuses.length === 2 && statuses.every((status) => status >= 400);
      return allRefused && outcome.reachedWhileDown === 0;
    },
    tryNext: "when the policy engine does not answer, decide deny: fail closed, not open",
  },
] satisfies Rule[];
