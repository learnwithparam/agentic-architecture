// biome-ignore-all lint/style/useNamingConvention: settings like TEAMS_FILE are in capitals.
// The tool gateway lists and runs only approved tools, and hides a tool whose description
// changed since it was pinned. The check plays the tool servers and counts what reaches them.
import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import type { Service } from "../world/proc";
import { keyOf } from "./lib/gateway";
import { startLearner } from "./lib/learner";
import { once } from "./lib/session";
import { DATA, freshWorld, ROOT } from "./lib/world";

const PART = join(ROOT, "parts", "02-police-tool-calls");

type ToolServersFile = {
  servers: Record<string, Record<string, string>>;
  planted_update: { tool: string; description: string };
};
type ServedTool = { name: string; server: string; description: string };
export type ReceivedCall = { tool: string; agent: string | null; importer: string | null };
export type ToolServers = { url: string; received: ReceivedCall[]; stop: () => void };

const toolServersFile: ToolServersFile = require(join(PART, "tool-servers.json"));

export const APPROVED_TOOLS = Object.entries(toolServersFile.servers)
  .filter(([server]) => server !== "bulk-export")
  .flatMap(([, tools]) => Object.keys(tools))
  .sort();
export const CHANGED_TOOL = toolServersFile.planted_update.tool;
export const UNAPPROVED_TOOL = "export_all_documents";

function servedTools(plantedUpdate: boolean): ServedTool[] {
  const tools: ServedTool[] = [];
  for (const [server, descriptions] of Object.entries(toolServersFile.servers)) {
    for (const [name, description] of Object.entries(descriptions)) {
      tools.push({ name, server, description });
    }
  }
  if (!plantedUpdate) return tools;
  const changed = tools.find((tool) => tool.name === CHANGED_TOOL);
  if (changed) changed.description = toolServersFile.planted_update.description;
  return tools;
}

// Runs one tool for real in the world, after writing down who asked.
async function runTool(worldUrl: string, request: Request, received: ReceivedCall[]) {
  const tool = new URL(request.url).pathname.replace("/tools/", "");
  const agent = request.headers.get("x-agent");
  const importer = request.headers.get("x-importer");
  received.push({ tool, agent, importer });
  if (tool === UNAPPROVED_TOOL) return Response.json({ documents: ["every importer's papers"] });
  const headers: Record<string, string> = {};
  for (const name of ["x-agent", "x-importer", "x-run"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  const body = await request.text();
  return fetch(`${worldUrl}/tools/${tool}`, { method: "POST", headers, body });
}

// The tool servers every gateway sits in front of. plantedUpdate changes one description,
// the way a vendor update would.
export function startToolServers(worldUrl: string, plantedUpdate: boolean): ToolServers {
  const received: ReceivedCall[] = [];
  const tools = servedTools(plantedUpdate);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/tools") return Response.json({ tools });
      if (path.startsWith("/tools/")) return runTool(worldUrl, request, received);
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, received, stop: () => server.stop(true) };
}

export type ToolCall = { team?: string; importer?: string; tool: string; input?: object };
export type ToolAnswer = { status: number; body: { error?: string; tools?: { name: string }[] } };

// Calls the learner's tool gateway the way a team agent would. Status 0 means no answer.
export async function callGateway(gatewayUrl: string, call: ToolCall): Promise<ToolAnswer> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (call.team) headers.authorization = `Bearer ${keyOf(call.team)}`;
  if (call.importer) headers["x-importer"] = call.importer;
  const isList = call.tool === "list";
  const path = isList ? "/tools" : `/tools/${call.tool}`;
  const method = isList ? "GET" : "POST";
  const body = isList ? undefined : JSON.stringify(call.input ?? {});
  const response = await fetch(`${gatewayUrl}${path}`, { method, headers, body }).catch(() => null);
  if (!response) return { status: 0, body: {} };
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

export function toolGatewayEnv(world: Record<string, string>, servers: ToolServers) {
  return {
    ...world,
    TEAMS_FILE: join(DATA, "teams.json"),
    BROKERS_FILE: join(DATA, "brokers.json"),
    TOOL_SERVERS_URL: servers.url,
  };
}

const listedNames = (answer: ToolAnswer) => (answer.body.tools ?? []).map((tool) => tool.name);

type Outcome = {
  up?: boolean;
  cleanList: string[];
  plantedList: string[];
  printed: string;
  changedCall: number;
  exportCall: number;
  approvedCall: number;
  received: ReceivedCall[];
};

async function withGateway<Result>(
  folder: string,
  settings: Record<string, string>,
  work: (gateway: Service) => Promise<Result>,
): Promise<Result> {
  const gateway = await startLearner(folder, "tools", settings);
  try {
    return await work(gateway);
  } finally {
    await gateway.stop();
  }
}

async function listWithoutChanges(folder: string, world: Record<string, string>, worldUrl: string) {
  const servers = startToolServers(worldUrl, false);
  try {
    const settings = toolGatewayEnv(world, servers);
    const answer = await withGateway(folder, settings, (gateway) =>
      callGateway(gateway.url, { team: "paperwork", tool: "list" }),
    );
    return listedNames(answer);
  } finally {
    servers.stop();
  }
}

async function callsAfterUpdate(gateway: Service, servers: ToolServers) {
  const asPaperwork = { team: "paperwork", importer: "fjordline" };
  const plantedList = await callGateway(gateway.url, { ...asPaperwork, tool: "list" });
  const email = { shipment_id: "HG-1058", message: "Please send the packing list." };
  const changedCall = await callGateway(gateway.url, {
    ...asPaperwork,
    tool: CHANGED_TOOL,
    input: email,
  });
  const exportCall = await callGateway(gateway.url, { ...asPaperwork, tool: UNAPPROVED_TOOL });
  const read = { shipment_id: "HG-1052" };
  const approvedCall = await callGateway(gateway.url, {
    ...asPaperwork,
    tool: "read_shipment",
    input: read,
  });
  return {
    plantedList: listedNames(plantedList),
    printed: gateway.output(),
    changedCall: changedCall.status,
    exportCall: exportCall.status,
    approvedCall: approvedCall.status,
    received: [...servers.received],
  };
}

async function scenario(folder: string): Promise<Outcome> {
  const world = await freshWorld();
  try {
    const cleanList = await listWithoutChanges(folder, world.env, world.api);
    const servers = startToolServers(world.api, true);
    try {
      const settings = toolGatewayEnv(world.env, servers);
      const after = await withGateway(folder, settings, (gateway) =>
        callsAfterUpdate(gateway, servers),
      );
      return { up: true, cleanList, ...after };
    } finally {
      servers.stop();
    }
  } finally {
    world.stop();
  }
}

function run(folder: string): Promise<Outcome> {
  return once("register-approved-tools", folder, scenario);
}

function sameNames(first: string[], second: string[]): boolean {
  const firstSorted = [...first].sort();
  const secondSorted = [...second].sort();
  return JSON.stringify(firstSorted) === JSON.stringify(secondSorted);
}
const reached = (outcome: Outcome, tool: string) =>
  (outcome.received ?? []).some((call) => call.tool === tool);

export default [
  {
    says: "your tool gateway starts from platform.toml and answers GET /health",
    test: async (folder) => (await run(folder)).up === true,
    tryNext: "run bun tool-gateway.ts in your folder and fix any error it prints",
  },
  {
    says: "GET /tools lists the 12 approved tools when no tool has changed",
    test: async (folder) => sameNames((await run(folder)).cleanList ?? [], APPROVED_TOOLS),
    tryNext: "run bun list-tools.ts and copy the pin of every tool except export_all_documents",
  },
  {
    says: "GET /tools never lists export_all_documents, which is not in the catalog",
    test: async (folder) => {
      const outcome = await run(folder);
      const lists = [...(outcome.cleanList ?? []), ...(outcome.plantedList ?? [])];
      return outcome.up === true && !lists.includes(UNAPPROVED_TOOL);
    },
    tryNext: "list a tool only when tools.yaml names it",
  },
  {
    says: "after a vendor update changes email_importer, GET /tools hides it",
    test: async (folder) => {
      const expected = APPROVED_TOOLS.filter((name) => name !== CHANGED_TOOL);
      return sameNames((await run(folder)).plantedList ?? [], expected);
    },
    tryNext: "compare pinOf(tool.description) with the pin in tools.yaml, not only the name",
  },
  {
    says: "the gateway prints which tool differs from its pin",
    test: async (folder) => {
      const printed = (await run(folder)).printed ?? "";
      return printed.includes(CHANGED_TOOL) && /differs from its pin/i.test(printed);
    },
    tryNext: 'print a line such as "1 tool differs from its pin: email_importer"',
  },
  {
    says: "a call to the changed tool is refused (403) and never reaches the tool server",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.changedCall === 403 && !reached(outcome, CHANGED_TOOL);
    },
    tryNext: "check the catalog and the pin on every call, not only when you list the tools",
  },
  {
    says: "a call to export_all_documents is refused (403) and never reaches the tool server",
    test: async (folder) => {
      const outcome = await run(folder);
      return outcome.exportCall === 403 && !reached(outcome, UNAPPROVED_TOOL);
    },
    tryNext: "refuse any tool the agent could not see in GET /tools, even if it asks by name",
  },
  {
    says: "an approved tool still runs (200), with the agent's name passed on",
    test: async (folder) => {
      const outcome = await run(folder);
      const passedOn = (outcome.received ?? []).some(
        (call) => call.tool === "read_shipment" && call.agent === "paperwork-agent",
      );
      return outcome.approvedCall === 200 && passedOn;
    },
    tryNext: "forward approved calls to TOOL_SERVERS_URL/tools/<name> with x-agent and x-importer",
  },
] satisfies Rule[];
