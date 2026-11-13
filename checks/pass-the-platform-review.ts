// biome-ignore-all lint/style/useNamingConvention: settings like TEAMS_FILE are in capitals.
// The platform passes the review: review/platform.md maps all nine layers to a contract, a check
// and three products, and the named checks pass. A fourth team (Billing) onboards with one command
// that changes data only, its agent works on the platform, and the report card stays clean.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findStep } from "../scripts/structure";
import type { Rule } from "../scripts/verify";
import type { Card } from "../world/report";
import { card } from "../world/report";
import type { World } from "../world/services";
import { gatewayEnv } from "./lib/gateway";
import { platformToml, startLearner } from "./lib/learner";
import { once } from "./lib/session";
import { freshWorld, numberFrom, ROOT } from "./lib/world";
import {
  failingRules,
  LAYERS,
  runTeamAgent,
  runTheQueue,
  startPlatformServices,
} from "./swap-one-layer";

const STEP_FOLDER = join(ROOT, "parts", "09-swap-and-review", "02-pass-the-platform-review");
const BILLING_TOOLS = ["list_open_shipments", "read_shipment", "email_importer"];
const BILLING_BUDGET = 500000;
const DATA_FILES = {
  TEAMS_FILE: "teams.json",
  POLICY_FILE: "policy.json",
  BUDGETS_FILE: "budgets.json",
};

type Team = { team: string; agent: string; key: string };
type ReviewRow = { layer: string; cells: string[]; check: string };
type Onboarded = {
  teams: Team[];
  policy: Record<string, string[]>;
  budgets: { teams: Record<string, number> };
};

// ---- review/platform.md ----

function reviewRows(folder: string): ReviewRow[] {
  const file = join(folder, "review", "platform.md");
  if (!existsSync(file)) return [];
  const tableLines = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("| `"));
  return tableLines.map((line) => {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const unquote = (text: string) => text.replaceAll("`", "").trim();
    return { layer: unquote(cells[0]), cells, check: unquote(cells[2] ?? "") };
  });
}

function rowFor(folder: string, layer: string): ReviewRow | undefined {
  return reviewRows(folder).find((row) => row.layer === layer);
}

// A built check runs on this folder only when the folder starts every service that check starts.
function sectionsOf(folder: string): string[] {
  return Object.keys(platformToml(folder));
}

function runnableHere(stepName: string, folder: string): boolean {
  const step = findStep(stepName);
  if (!step) return false;
  const needed = sectionsOf(join(step.dir, "solution"));
  const present = sectionsOf(folder);
  return needed.length > 0 && needed.every((section) => present.includes(section));
}

// ---- onboarding ----

function codeSnapshot(folder: string): string {
  const names = readdirSync(folder, { recursive: true }) as string[];
  const codeFiles = names.filter((name) => /\.(ts|js|py)$/.test(name) && !name.startsWith("out"));
  const contents = codeFiles.sort().map((name) => name + readFileSync(join(folder, name), "utf8"));
  const services = readFileSync(join(STEP_FOLDER, "platform-services.ts"), "utf8");
  return Bun.hash(contents.join("\n") + services).toString();
}

function copyDataFiles(folder: string): Record<string, string> {
  const copies = join(ROOT, "world", "state", `check-onboard-${crypto.randomUUID()}`);
  mkdirSync(copies, { recursive: true });
  const settings: Record<string, string> = {};
  for (const [setting, name] of Object.entries(DATA_FILES)) {
    if (existsSync(join(folder, name))) copyFileSync(join(folder, name), join(copies, name));
    settings[setting] = join(copies, name);
  }
  return settings;
}

function onboardBilling(folder: string, dataFiles: Record<string, string>): number {
  const command = String(platformToml(folder).onboard?.command ?? "false");
  const line = `${command} billing ${BILLING_TOOLS.join(",")} ${BILLING_BUDGET}`;
  const settings = { ...process.env, ...dataFiles };
  const onboard = Bun.spawnSync(["sh", "-c", line], { cwd: folder, env: settings });
  return onboard.exitCode;
}

function readOnboarded(dataFiles: Record<string, string>): Onboarded {
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  return {
    teams: read(dataFiles.TEAMS_FILE),
    policy: read(dataFiles.POLICY_FILE),
    budgets: read(dataFiles.BUDGETS_FILE),
  };
}

// ---- running the platform ----

async function deniedPayment(servicesUrl: string, billing: Team): Promise<number> {
  const tokenAnswer = await fetch(`${servicesUrl}/token`, {
    method: "POST",
    body: JSON.stringify({ agent: billing.agent, secret: billing.key }),
  });
  const { token } = (await tokenAnswer.json()) as { token?: string };
  const payment = await fetch(`${servicesUrl}/tools/pay_fee`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-importer": "ridgeway" },
    body: JSON.stringify({ shipment_id: "HG-1050", idempotency_key: "billing-try" }),
  });
  return payment.status;
}

function billingEvidence(world: World) {
  const count = (sql: string) => numberFrom(world, sql);
  return {
    billedCalls: count("SELECT COUNT(*) AS total FROM spend_log WHERE team = 'billing'"),
    toolCalls: count(
      "SELECT COUNT(*) AS total FROM tool_audit WHERE agent = 'billing-agent' AND outcome = 'ok'",
    ),
    emails: count("SELECT COUNT(*) AS total FROM emails WHERE agent = 'billing-agent'"),
  };
}

async function runPlatform(
  world: World,
  folder: string,
  dataFiles: Record<string, string>,
  billing?: Team,
) {
  const gatewaySettings = gatewayEnv(world.env, dataFiles);
  const gateway = await startLearner(folder, "gateway", gatewaySettings);
  const services = await startPlatformServices(world, folder, dataFiles);
  try {
    const urls = { GATEWAY_URL: gateway.url, PLATFORM_URL: services.url };
    const queue = await runTheQueue(world, urls);
    if (!billing) return { queue, billingFinished: false, paymentStatus: 0 };
    const billingSettings = {
      ...urls,
      AGENT: billing.agent,
      TEAM_KEY: billing.key,
      RUN_ID: "billing-run-1",
    };
    const billingFinished = await runTeamAgent(
      join(folder, "teams", "billing.ts"),
      billingSettings,
    );
    const paymentStatus = await deniedPayment(services.url, billing);
    return { queue, billingFinished, paymentStatus };
  } finally {
    await gateway.stop();
    await services.stop();
  }
}

export async function reviewThePlatform(folder: string) {
  const namedChecks = reviewRows(folder).map((row) => row.check);
  const checksRun = namedChecks.filter((stepName) => runnableHere(stepName, folder));
  const failed = await failingRules(checksRun, folder);
  const dataFiles = copyDataFiles(folder);
  const codeBefore = codeSnapshot(folder);
  const exitCodes = [onboardBilling(folder, dataFiles), onboardBilling(folder, dataFiles)];
  const codeUnchanged = codeSnapshot(folder) === codeBefore;
  const onboarded = readOnboarded(dataFiles);
  const billing = onboarded.teams.find((team) => team.team === "billing");
  const world = await freshWorld();
  try {
    const outcome = await runPlatform(world, folder, dataFiles, billing);
    const finalCard: Card = card(world.db, join(ROOT, "teams"));
    const evidence = billingEvidence(world);
    return {
      checksRun,
      failed,
      exitCodes,
      codeUnchanged,
      onboarded,
      ...outcome,
      finalCard,
      evidence,
    };
  } finally {
    world.stop();
  }
}

function run(folder: string) {
  return once("pass-the-platform-review", folder, reviewThePlatform);
}

const filled = (cell: string | undefined) => (cell ?? "").replace(/TODO/i, "").trim().length > 2;

function billingTeams(onboarded: Onboarded | undefined): Team[] {
  return onboarded?.teams?.filter((team) => team.team === "billing") ?? [];
}

function hasOwnNewKey(onboarded: Onboarded | undefined): boolean {
  const billing = billingTeams(onboarded);
  if (billing.length !== 1) return false;
  const otherKeys = (onboarded?.teams ?? [])
    .filter((team) => team.team !== "billing")
    .map((team) => team.key);
  return billing[0].key.startsWith("hgk_billing_") && !otherKeys.includes(billing[0].key);
}

export default [
  {
    says: "review/platform.md has one row for each of the nine layers",
    test: (folder) => {
      const layers = reviewRows(folder).map((row) => row.layer);
      const oneEach = Object.keys(LAYERS).every(
        (layer) => layers.filter((name) => name === layer).length === 1,
      );
      return oneEach && layers.length === 9;
    },
    tryNext: `write one table row per layer, starting with its name in backticks: ${Object.keys(LAYERS).join(", ")}`,
  },
  {
    says: "every row fills the contract, the three products and the gap",
    test: (folder) => {
      const rows = reviewRows(folder);
      const fillsEveryCell = (row: ReviewRow) =>
        [1, 3, 4, 5, 6].every((index) => filled(row.cells[index]));
      return rows.length === 9 && rows.every(fillsEveryCell);
    },
    tryNext:
      "fill Contract, the three product columns and Gap on every row; write none if a product has none",
  },
  {
    says: "every row names a check that proves its layer",
    test: (folder) => {
      const rows = Object.keys(LAYERS).map((layer) => rowFor(folder, layer));
      return rows.every((row) => row !== undefined && LAYERS[row.layer].includes(row.check));
    },
    tryNext:
      "in Check, name one step of that layer, such as route-calls-through-gateway for model-gateway",
  },
  {
    says: "the named checks that run on this folder pass, the model gateway among them",
    test: async (folder) => {
      const outcome = await run(folder);
      const gatewayRan = outcome.checksRun?.some((stepName) =>
        LAYERS["model-gateway"].includes(stepName),
      );
      return Boolean(gatewayRan) && outcome.failed?.length === 0;
    },
    tryNext: "keep [gateway] in platform.toml and fix the FAIL lines of that check",
  },
  {
    says: "onboarding adds Billing once, with its own new key, its tools and its budget",
    test: async (folder) => {
      const { exitCodes, onboarded } = await run(folder);
      const tools = onboarded?.policy?.["billing-agent"] ?? [];
      const sameTools =
        JSON.stringify([...tools].sort()) === JSON.stringify([...BILLING_TOOLS].sort());
      const budget = onboarded?.budgets?.teams?.billing === BILLING_BUDGET;
      return (
        exitCodes?.every((code) => code === 0) && hasOwnNewKey(onboarded) && sameTools && budget
      );
    },
    tryNext: "add the team once with newTeamKey, set its policy to the tools, and its budget",
  },
  {
    says: "onboarding changed data only: no code file changed",
    test: async (folder) => (await run(folder)).codeUnchanged === true,
    tryNext: "write only TEAMS_FILE, POLICY_FILE and BUDGETS_FILE; never a .ts file",
  },
  {
    says: "the Billing agent works on the platform and is refused a tool it was not given",
    test: async (folder) => {
      const { billingFinished, evidence, paymentStatus } = await run(folder);
      const usedThePlatform =
        evidence?.billedCalls > 0 && evidence.toolCalls > 0 && evidence.emails > 0;
      return billingFinished === true && usedThePlatform && paymentStatus === 403;
    },
    tryNext: "give billing-agent exactly the tools it needs in the policy, and its own key",
  },
  {
    says: "with Billing on board, the report card is still all zeros",
    test: async (folder) => {
      const { queue, finalCard } = await run(folder);
      if (!queue?.agentsFinished || !finalCard) return false;
      return Object.values(finalCard).every((count) => count === 0);
    },
    tryNext:
      "run bun run after to compare; every team must call through the gateway and the tool gateway",
  },
] satisfies Rule[];
